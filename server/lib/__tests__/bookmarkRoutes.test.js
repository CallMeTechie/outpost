const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { bookmarkPathHash, normalizeBookmarkPath } = require("../bookmarkPath");

// server/controllers/bookmarks.js talks to the database (Entry, FileBookmark) and to two
// collaborators (server/controllers/entry.js, server/utils/permission.js) through `require`, not
// through injection. To characterize the five routes without a real database, we swap those
// modules in require.cache for in-memory fakes *before* the controller or the routers are first
// required, so every `require(...)` call they make resolves to a fake.
//
// Two shapes of fake are used depending on how the consuming module pulls the dependency in:
//   - `db` (server/utils/database) and `FileBookmark`, `Entry`, `Session`, `Account` are used as
//     `Module.method(...)`, i.e. the module object itself is referenced at call time, so a fake
//     object with methods closing over mutable state is enough - no re-requiring needed between
//     tests.
//   - `resolveEntryScope`/`validateEntryAccess` (from "./entry") and `hasResourcePermission` (from
//     "../utils/permission") are pulled out of their modules with destructuring
//     (`const { hasResourcePermission } = require(...)`), which captures the function value at
//     load time. The fakes are therefore installed in require.cache before the controller is ever
//     required, so its destructuring captures the fake functions, not the real ones.
//
// `resolveEntryScope`/`validateEntryAccess` are reimplemented here rather than faked as
// always-true/always-false stubs, because the two traps this task exists to catch
// (validateEntryAccess answering with a truthy object, and checking entry.organizationId instead
// of the resolved scope) only show up if the fake actually distinguishes "no access" from "access",
// the way the real functions do. `../../controllers/entry` in the real tree also pulls in a dozen
// other models and controllers (Folder, EntryTag, Tag, AuditLog, Identity, OrganizationMember,
// ./folder, ./identity, ./audit, ...) purely to define its own exports; faking the whole module
// avoids needing fakes for all of those just to load it.

const ORG_MEMBERS = {
    org1: new Set([1, 2]), // account 1 ("A") and account 2 ("B") share server 1
    org2: new Set([1]),    // A is a member, but (see hasResourcePermission fake) lacks FILES_VIEW there
};

const entryControllerPath = require.resolve("../../controllers/entry");
require.cache[entryControllerPath] = {
    id: entryControllerPath, filename: entryControllerPath, loaded: true,
    exports: {
        resolveEntryScope: async (entry) => {
            // Mirrors the real function: a folder's scope overrides the entry's own scope. Test
            // entries that live in an organization folder carry a `folderScope` fixture field
            // standing in for a real Folder lookup.
            if (entry.folderScope) return { ...entry.folderScope };
            return { organizationId: entry.organizationId ?? null, ownerAccountId: entry.accountId ?? null };
        },
        validateEntryAccess: async function validateEntryAccess(accountId, entry, errorMessage = "You don't have permission to access this entry") {
            if (!entry) return { code: 401, message: "Entry does not exist" };
            const { organizationId, ownerAccountId } = await this.resolveEntryScope(entry);
            if (organizationId) {
                const allowed = (ORG_MEMBERS[organizationId] || new Set()).has(accountId);
                if (!allowed) return { code: 403, message: "You don't have access to this organization's entry" };
            } else if (ownerAccountId && ownerAccountId !== accountId) {
                return { code: 403, message: errorMessage };
            }
            return { valid: true, entry };
        },
    },
};
// validateEntryAccess calls resolveEntryScope through `this` so both live on the same exports
// object without a second, separately-updatable copy of the folder-override logic.
require.cache[entryControllerPath].exports.validateEntryAccess =
    require.cache[entryControllerPath].exports.validateEntryAccess.bind(require.cache[entryControllerPath].exports);

// FILES_VIEW is default-granted (permissions/registry.js), so the fake only needs to name the one
// scope where it was deliberately taken away: account 1 inside org2.
const FILES_VIEW_DENIED = new Set(["1:org2"]);

const permissionPath = require.resolve("../../utils/permission");
require.cache[permissionPath] = {
    id: permissionPath, filename: permissionPath, loaded: true,
    exports: {
        hasResourcePermission: async (accountId, organizationId) =>
            !FILES_VIEW_DENIED.has(`${accountId}:${organizationId ?? "null"}`),
    },
};

// Entry 101: org1, shared by accounts 1 and 2 - two accounts with access to the same server.
// Entry 102: org2, account 1 is a member but FILES_VIEW was taken away there.
// Entry 103: account 2's PERSONAL entry (organizationId null) - the case the wrong
//            validateEntryAccess signature would have let account 1 read and write.
// Entry 104: organizationId null on the entry itself, but it sits in an org2 folder, where account
//            1 is a member yet lacks FILES_VIEW (same denial as entry 102). A buggy authorizeEntry
//            that checked entry.organizationId (null) instead of the resolved scope would treat
//            this as a "personal, unowned" entry - ownerAccountId is also null, so
//            validateEntryAccess's non-organization branch never rejects it either - and would
//            wrongly fall through to hasResourcePermission(accountId, null, FILES_VIEW), which is
//            default-granted. The correct code checks org2 and gets the 403 the denial calls for.
// Entry 105: account 1's personal entry, reserved for the path-normalization collision case.
// Entry 106: account 1's personal entry, empty - reserved for the two-different-positions case.
// Entry 107: account 99's personal entry, reserved exclusively for the rate-limit case.
const ENTRIES = new Map([
    [101, { id: 101, organizationId: "org1", accountId: null, folderId: null }],
    [102, { id: 102, organizationId: "org2", accountId: null, folderId: null }],
    [103, { id: 103, organizationId: null, accountId: 2, folderId: null }],
    [104, { id: 104, organizationId: null, accountId: null, folderId: null, folderScope: { organizationId: "org2", ownerAccountId: null } }],
    [105, { id: 105, organizationId: null, accountId: 1, folderId: null }],
    [106, { id: 106, organizationId: null, accountId: 1, folderId: null }],
    [107, { id: 107, organizationId: null, accountId: 99, folderId: null }],
]);

const entryPath = require.resolve("../../models/Entry");
require.cache[entryPath] = {
    id: entryPath, filename: entryPath, loaded: true,
    exports: { findByPk: async (id) => ENTRIES.get(id) ?? null },
};

// authenticate (server/middlewares/auth.js) needs Session, Account and the api-key gate. Sessions
// map directly to accounts 1 ("A"), 2 ("B") and 99 (isolated, for the rate-limit case).
const SESSIONS = new Map([
    ["token-A", { id: 1, accountId: 1 }],
    ["token-B", { id: 2, accountId: 2 }],
    ["token-C", { id: 3, accountId: 99 }],
]);

const sessionPath = require.resolve("../../models/Session");
require.cache[sessionPath] = {
    id: sessionPath, filename: sessionPath, loaded: true,
    exports: {
        findOne: async ({ where: { token } }) => SESSIONS.get(token) ?? null,
        update: async () => [0],
    },
};

const accountPath = require.resolve("../../models/Account");
require.cache[accountPath] = {
    id: accountPath, filename: accountPath, loaded: true,
    exports: { findByPk: async (id) => ({ id }) },
};

const apiKeyPath = require.resolve("../../controllers/apiKey");
require.cache[apiKeyPath] = {
    id: apiKeyPath, filename: apiKeyPath, loaded: true,
    exports: { isApiKeyToken: () => false, validateApiKey: async () => null },
};

// The in-memory FileBookmark fake. `raw: true` (server/utils/database.js) means every real finder
// returns a plain object, so this fake does the same - never anything with instance methods.
//
// __arm()/__waitUntilHeld()/__release() give the two concurrency tests a deterministic handle on
// "the transaction has acquired the database-wide lock and is about to do its first read", instead
// of relying on the relative timing of two real HTTP round trips. The hold fires on the first
// FileBookmark call made WITH a `transaction` option, which is always the first thing each of
// createBookmark/deleteBookmark/reorderBookmarks does once inside db.transaction() - so "held"
// and "the fake lock is acquired" are the same moment.
let rows = [];
let nextId = 1;
let holdArmed = false;
let holdRelease = null;
let holdWaiters = [];

const maybeHold = async () => {
    if (!holdArmed) return;
    holdArmed = false;
    await new Promise((resolve) => {
        holdRelease = resolve;
        holdWaiters.splice(0).forEach((w) => w());
    });
};

const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
const clone = (row) => ({ ...row });

const FileBookmarkFake = {
    findAll: async ({ where = {}, order, transaction } = {}) => {
        if (transaction) await maybeHold();
        let result = rows.filter((r) => matches(r, where));
        if (order) {
            result = [...result].sort((a, b) => {
                for (const [field, dir] of order) {
                    if (a[field] !== b[field]) return dir === "ASC" ? a[field] - b[field] : b[field] - a[field];
                }
                return 0;
            });
        }
        return result.map(clone);
    },
    findOne: async ({ where = {}, transaction } = {}) => {
        if (transaction) await maybeHold();
        const found = rows.find((r) => matches(r, where));
        return found ? clone(found) : null;
    },
    max: async (field, { where = {}, transaction } = {}) => {
        if (transaction) await maybeHold();
        const filtered = rows.filter((r) => matches(r, where));
        if (filtered.length === 0) return null;
        return Math.max(...filtered.map((r) => r[field]));
    },
    create: async (data, { transaction } = {}) => {
        if (transaction) await maybeHold();
        const dup = rows.find((r) =>
            r.accountId === data.accountId && r.entryId === data.entryId && r.pathHash === data.pathHash);
        if (dup) {
            const error = new Error("Validation error");
            error.name = "SequelizeUniqueConstraintError";
            error.parent = { message: "SQLITE_CONSTRAINT: UNIQUE constraint failed: file_bookmarks.accountId, file_bookmarks.entryId, file_bookmarks.pathHash" };
            throw error;
        }
        const row = { id: nextId++, createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.push(row);
        return clone(row);
    },
    update: async (data, { where = {}, transaction } = {}) => {
        if (transaction) await maybeHold();
        let count = 0;
        rows = rows.map((r) => {
            if (matches(r, where)) { count += 1; return { ...r, ...data }; }
            return r;
        });
        return [count];
    },
    destroy: async ({ where = {}, transaction } = {}) => {
        if (transaction) await maybeHold();
        const before = rows.length;
        rows = rows.filter((r) => !matches(r, where));
        return before - rows.length;
    },
};

const fileBookmarkPath = require.resolve("../../models/FileBookmark");
require.cache[fileBookmarkPath] = { id: fileBookmarkPath, filename: fileBookmarkPath, loaded: true, exports: FileBookmarkFake };

// The fake database: one global lock, exactly like SQLite's database-wide write lock. A second
// `transaction()` call while one is already open throws immediately, the same shape of error
// isLockConflict (server/controllers/bookmarks.js) matches.
let dbLocked = false;
const dbFake = {
    transaction: async (run) => {
        if (dbLocked) throw new Error("SQLITE_BUSY: database is locked");
        dbLocked = true;
        try {
            return await run({ fake: true });
        } finally {
            dbLocked = false;
        }
    },
};

const databasePath = require.resolve("../../utils/database");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: dbFake };

// Safe to load now: every dependency the controller and the two routers resolve to a fake, except
// server/lib/bookmarkPath.js and server/lib/bookmarkOrder.js (pure functions, Tasks 1 and this
// task's Step 3) and server/permissions/registry.js (constants only). None of the files under test
// are modified.
const entryBookmarksRouter = require("../../routes/entryBookmarks");
const bookmarksRouter = require("../../routes/bookmarks");

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/entries", entryBookmarksRouter);
    app.use("/api/bookmarks", bookmarksRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

// The same starting state for every test: three of account 1's bookmarks on the shared server
// (101), one of account 2's on that same server, one of account 1's on the FILES_VIEW-denied
// server (102), and one of account 1's on the path-collision server (105). Resetting before every
// test - rather than letting mutations from one test leak into the next - is what "vom gleichen
// Ausgangszustand aus" in the brief asks for.
const seedRow = (id, accountId, entryId, name, path, position) =>
    ({ id, accountId, entryId, name, path, pathHash: bookmarkPathHash(normalizeBookmarkPath(path)), position });

test.beforeEach(() => {
    rows = [
        seedRow(1, 1, 101, "root", "/", 0),
        seedRow(2, 1, 101, "etc", "/etc", 1),
        seedRow(3, 1, 101, "var", "/var", 2),
        seedRow(4, 2, 101, "b-home", "/home", 0),
        seedRow(5, 1, 102, "docker", "/docker", 0),
        seedRow(6, 1, 105, "docker-share", "/volume1/docker", 0),
    ];
    nextId = 7;
    dbLocked = false;
    holdArmed = false;
    holdRelease = null;
    holdWaiters = [];
});

const authed = (token, init = {}) => ({
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}` },
});
const jsonBody = (body) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const get = (path, token) => fetch(`${baseUrl}${path}`, authed(token));
const post = (path, token, body) => fetch(`${baseUrl}${path}`, authed(token, { method: "POST", ...jsonBody(body) }));
const put = (path, token, body) => fetch(`${baseUrl}${path}`, authed(token, { method: "PUT", ...jsonBody(body) }));
const patch = (path, token, body) => fetch(`${baseUrl}${path}`, authed(token, { method: "PATCH", ...jsonBody(body) }));
const del = (path, token) => fetch(`${baseUrl}${path}`, authed(token, { method: "DELETE" }));

const rowsFor = (accountId, entryId) => rows.filter((r) => r.accountId === accountId && r.entryId === entryId);

const waitUntilHeld = () => new Promise((resolve) => {
    if (holdRelease) return resolve();
    holdWaiters.push(resolve);
});
const releaseHold = () => { const r = holdRelease; holdRelease = null; if (r) r(); };

const assertNoLeak = (text) => {
    assert.doesNotMatch(text, /stack/i);
    assert.doesNotMatch(text, /file_bookmarks/i);
    assert.doesNotMatch(text, /SQLITE_CONSTRAINT/i);
    assert.doesNotMatch(text, /pathHash/i);
};

test("account A sees its three bookmarks on server 1, ordered by position", async () => {
    const res = await get("/entries/101/bookmarks", "token-A");
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(body.map((b) => b.id), [1, 2, 3]);
});

test("account A sees NONE of account B's bookmarks on the same server", async () => {
    const res = await get("/entries/101/bookmarks", "token-A");
    const body = await res.json();

    assert.ok(!body.some((b) => b.id === 4), "account B's bookmark must not appear in A's list");
});

test("account A without FILES_VIEW on server 2 gets 403, not an empty list", async () => {
    const res = await get("/entries/102/bookmarks", "token-A");
    const body = await res.json();

    assert.strictEqual(res.status, 403);
    assert.notStrictEqual(res.status, 200);
    assert.ok(!Array.isArray(body));
});

test("account A reaching account B's PERSONAL entry: GET, POST and PUT order all answer 404 and create no row - the case the wrong validateEntryAccess signature would have let through", async () => {
    const getRes = await get("/entries/103/bookmarks", "token-A");
    assert.strictEqual(getRes.status, 404);

    const postRes = await post("/entries/103/bookmarks", "token-A", { name: "x", path: "/x" });
    assert.strictEqual(postRes.status, 404);
    assert.deepStrictEqual(rowsFor(1, 103), [], "no row must have been created");

    const putRes = await put("/entries/103/bookmarks/order", "token-A", { ids: [] });
    assert.strictEqual(putRes.status, 404);
});

test("an entry with organizationId null inside an organization folder is checked against the folder's organization, not against null", async () => {
    const res = await get("/entries/104/bookmarks", "token-A");
    assert.strictEqual(res.status, 403,
        "account A is a member of org2 (validateEntryAccess passes) but lacks FILES_VIEW there - " +
        "checking entry.organizationId (null) instead of the resolved scope would default-grant this");
});

test("PATCH on an own bookmark whose server no longer grants FILES_VIEW: 403, nothing changed", async () => {
    const res = await patch("/bookmarks/5", "token-A", { name: "renamed" });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(rows.find((r) => r.id === 5).name, "docker");
});

test("DELETE on an own bookmark without FILES_VIEW: 403, nothing deleted", async () => {
    const res = await del("/bookmarks/5", "token-A");

    assert.strictEqual(res.status, 403);
    assert.ok(rows.some((r) => r.id === 5));
});

test("POST on an already-bookmarked path gives 409, and the response carries no stack, table or column names", async () => {
    const res = await post("/entries/101/bookmarks", "token-A", { name: "dup", path: "/etc" });
    const text = await res.text();

    assert.strictEqual(res.status, 409);
    assertNoLeak(text);
});

test("POST with an entryId that does not exist gives 404 and no stack - NODE_ENV is NOT \"production\" here", async () => {
    assert.notStrictEqual(process.env.NODE_ENV, "production");

    const res = await post("/entries/999999/bookmarks", "token-A", { name: "x", path: "/x" });
    const text = await res.text();

    assert.strictEqual(res.status, 404);
    assertNoLeak(text);
});

test("POST with '/volume1/docker/' hits the same unique index as '/volume1/docker'", async () => {
    const res = await post("/entries/105/bookmarks", "token-A", { name: "dup", path: "/volume1/docker/" });

    assert.strictEqual(res.status, 409);
});

test("PUT order with a missing id gives 409 and changes not a single position", async () => {
    const res = await put("/entries/101/bookmarks/order", "token-A", { ids: [1, 2] });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(rows.find((r) => r.id === 1).position, 0);
    assert.strictEqual(rows.find((r) => r.id === 2).position, 1);
    assert.strictEqual(rows.find((r) => r.id === 3).position, 2);
});

test("PUT order with the same set in a different order gives 200 and writes 0,1,2", async () => {
    const res = await put("/entries/101/bookmarks/order", "token-A", { ids: [3, 1, 2] });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(rows.find((r) => r.id === 3).position, 0);
    assert.strictEqual(rows.find((r) => r.id === 1).position, 1);
    assert.strictEqual(rows.find((r) => r.id === 2).position, 2);
});

test("two PUT order requests at the same time on the same list: one wins completely, the other gets 409 - never a mixed order, never a 500", async () => {
    holdArmed = true;
    const p1 = put("/entries/101/bookmarks/order", "token-A", { ids: [3, 2, 1] });

    await waitUntilHeld(); // p1 has acquired the fake DB lock and is paused on its first read

    const res2 = await put("/entries/101/bookmarks/order", "token-A", { ids: [2, 1, 3] });
    assert.strictEqual(res2.status, 409, "the second request must fail while the first still holds the lock");

    releaseHold();
    const res1 = await p1;
    assert.strictEqual(res1.status, 200);

    // The final state is entirely request 1's write (3,2,1 -> 0,1,2), never a mix of the two.
    assert.strictEqual(rows.find((r) => r.id === 3).position, 0);
    assert.strictEqual(rows.find((r) => r.id === 2).position, 1);
    assert.strictEqual(rows.find((r) => r.id === 1).position, 2);
});

test("DELETE of a foreign bookmark gives 404 and deletes nothing", async () => {
    const res = await del("/bookmarks/1", "token-B"); // bookmark 1 belongs to account A

    assert.strictEqual(res.status, 404);
    assert.ok(rows.some((r) => r.id === 1));
});

test("DELETE closes the gap: 0,1,2 becomes 0,1 again after removing the middle one", async () => {
    const res = await del("/bookmarks/2", "token-A"); // the middle of A's three bookmarks on entry 101

    assert.strictEqual(res.status, 200);
    assert.strictEqual(rows.find((r) => r.id === 1).position, 0);
    assert.strictEqual(rows.find((r) => r.id === 3).position, 1);
});

test("two POSTs at the same time on two different folders get two different positions", async () => {
    holdArmed = true;
    const p1 = post("/entries/106/bookmarks", "token-A", { name: "a", path: "/a" });

    await waitUntilHeld(); // p1 holds the lock inside its MAX(position) read

    const p2 = post("/entries/106/bookmarks", "token-A", { name: "b", path: "/b" });
    // p2's first attempt hits the lock and is now inside withLockRetry's 50ms backoff. Releasing
    // p1 well within that window lets p2's retry see p1's already-written row.
    releaseHold();

    const [res1, res2] = await Promise.all([p1, p2]);
    assert.strictEqual(res1.status, 201);
    assert.strictEqual(res2.status, 201);

    const body1 = await res1.json();
    const body2 = await res2.json();
    assert.notStrictEqual(body1.position, body2.position, "two different folders must not collide on the same position");
    assert.deepStrictEqual([body1.position, body2.position].sort(), [0, 1]);
});

test("61 POSTs in one minute: the 61st gives 429, and the response carries no stack or table names", async () => {
    let last;
    for (let i = 0; i < 61; i++) {
        last = await post("/entries/107/bookmarks", "token-C", { name: `p${i}`, path: `/p${i}` });
        if (i < 60) assert.notStrictEqual(last.status, 429, `request ${i} must not be rate-limited yet`);
    }
    const text = await last.text();

    assert.strictEqual(last.status, 429);
    assertNoLeak(text);
});

test("two DELETEs at the same time on the same bookmark: neither ends in a 500; the lock conflict is retried once", async () => {
    holdArmed = true;
    const p1 = del("/bookmarks/2", "token-A");

    await waitUntilHeld(); // p1 holds the lock inside its findOne read

    const p2 = del("/bookmarks/2", "token-A");
    // p2's first attempt hits the lock and enters withLockRetry's 50ms backoff. Releasing p1 well
    // within that window means p2's retry finds the row already gone.
    releaseHold();

    const [res1, res2] = await Promise.all([p1, p2]);
    assert.notStrictEqual(res1.status, 500);
    assert.notStrictEqual(res2.status, 500);
    assert.deepStrictEqual([res1.status, res2.status].sort(), [200, 404]);
});

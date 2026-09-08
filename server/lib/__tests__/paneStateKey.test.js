const test = require("node:test");
const assert = require("node:assert");
const { buildPaneStateKey, createPaneStateWriter } = require("../paneStateStore");
const { paneIdentityKey } = require("../paneIdentityKey");
const { resolveOpeningDirectory } = require("../parentChain");

// The key builder lives mid-way through sftpWS.js now, behind wsAuth, ConnectionService and the
// transfer handlers - too deep for the fake-require pattern sftpContentRoutes.test.js uses for a
// plain Express route. These tests drive server/lib/paneStateStore.js directly instead.

const rowKey = ({ accountId, entryId, identityId }) => `${accountId}:${entryId}:${identityId}`;

// The same starting state for every case below: two accounts, two servers (entries), each with one
// existing row - proving a key collapses onto (or diverges from) an already-occupied row, not just
// an empty table. Each test gets its own fresh copy of this same fixture.
const makeFixture = () => {
    const rows = new Map([
        [rowKey({ accountId: 1, entryId: 10, identityId: 0 }), { accountId: 1, entryId: 10, identityId: 0, lastPath: "/on-a" }],
        [rowKey({ accountId: 2, entryId: 20, identityId: 0 }), { accountId: 2, entryId: 20, identityId: 0, lastPath: "/on-b" }],
    ]);
    return {
        get: (key) => rows.get(rowKey(key)) ?? null,
        upsert: async (data) => { rows.set(rowKey(data), { ...data }); },
        rowCount: () => rows.size,
    };
};

test("two sessions of the same server with the same identity share one key - one row", async () => {
    const table = makeFixture();
    const writer = createPaneStateWriter({
        upsert: (key, path) => table.upsert({ ...key, lastPath: path }),
        delayMs: 5,
    });

    // Two separate connections to the same server, same account, same identity.
    const keyFromSessionA = buildPaneStateKey({ accountId: 1 }, 10, 0);
    const keyFromSessionB = buildPaneStateKey({ accountId: 1 }, 10, 0);
    assert.deepStrictEqual(keyFromSessionA, keyFromSessionB);

    writer.schedule(keyFromSessionA, "/on-a/docker");
    await writer.flush();

    assert.strictEqual(table.rowCount(), 2, "no new row appeared - the write collapsed onto the existing one");
    assert.strictEqual(table.get(keyFromSessionA).lastPath, "/on-a/docker");
});

test("the same server with two different identities makes two different keys, two rows", async () => {
    const table = makeFixture();
    // Two separate connections (each with its own writer, as sftpWS.js builds one per socket) -
    // flush() closes a writer for good, so reusing one across both identities would silently drop
    // the second write instead of proving the point.
    const upsert = (key, path) => table.upsert({ ...key, lastPath: path });
    const writerForIdentity5 = createPaneStateWriter({ upsert, delayMs: 5 });
    const writerForIdentity6 = createPaneStateWriter({ upsert, delayMs: 5 });

    const keyIdentity5 = buildPaneStateKey({ accountId: 1 }, 10, 5);
    const keyIdentity6 = buildPaneStateKey({ accountId: 1 }, 10, 6);
    assert.notDeepStrictEqual(keyIdentity5, keyIdentity6);

    writerForIdentity5.schedule(keyIdentity5, "/via-identity-5");
    writerForIdentity6.schedule(keyIdentity6, "/via-identity-6");
    await Promise.all([writerForIdentity5.flush(), writerForIdentity6.flush()]);

    assert.strictEqual(table.rowCount(), 4, "both identities landed in their own new row, next to the two seeded ones");
    assert.strictEqual(table.get(keyIdentity5).lastPath, "/via-identity-5");
    assert.strictEqual(table.get(keyIdentity6).lastPath, "/via-identity-6");
});

test("a directIdentity session (configuration.identityId is null) becomes identityId 0", () => {
    // The real null goes through paneIdentityKey - hand-setting 0 here would not exercise the
    // placeholder this test is actually about.
    const resolvedIdentity = paneIdentityKey({ configuration: { identityId: null } });
    const key = buildPaneStateKey({ accountId: 1 }, 10, resolvedIdentity);
    assert.strictEqual(key.identityId, 0);
});

test("two accounts on the same server make two different keys", () => {
    const keyAccount1 = buildPaneStateKey({ accountId: 1 }, 10, 0);
    const keyAccount2 = buildPaneStateKey({ accountId: 2 }, 10, 0);
    assert.notDeepStrictEqual(keyAccount1, keyAccount2);
});

test("a session without an entryId writes nothing", async () => {
    const table = makeFixture();
    const writes = [];
    const writer = createPaneStateWriter({
        upsert: async (key, path) => { writes.push([key, path]); await table.upsert({ ...key, lastPath: path }); },
        delayMs: 5,
    });

    // A direct connection has no entry (utils/directTarget.js) - buildPaneStateKey is handed null.
    const key = buildPaneStateKey({ accountId: 1 }, null, 0);
    writer.schedule(key, "/somewhere");
    await writer.flush();

    assert.strictEqual(writes.length, 0);
    assert.strictEqual(table.rowCount(), 2, "the seeded rows are untouched");
});

test("a climb writes the reached path back, a hit without a climb writes nothing", async () => {
    // Mirrors the write-back guard in sftpWS.js's opening chain:
    // `if (!opening.aborted && opening.restoredFrom && rememberedRow)`. resolveOpeningDirectory
    // sets restoredFrom only when the exact remembered path did not hold and a climb found
    // something else - never on a direct hit. That distinction is exactly what this test proves.
    const table = makeFixture();
    const paneStateKey = buildPaneStateKey({ accountId: 1 }, 10, 0);
    const rememberedRow = table.get(paneStateKey);
    assert.ok(rememberedRow, "the fixture must already hold this row for the guard to matter");

    const writeBackIfClimbed = async (opening) => {
        if (!opening.aborted && opening.restoredFrom && rememberedRow) {
            await table.upsert({ ...paneStateKey, lastPath: opening.path });
        }
    };

    // A hit: the exact remembered directory still holds, no climb needed.
    const hit = await resolveOpeningDirectory({
        storedSessionPath: null, storedRow: rememberedRow.lastPath,
        probe: async () => true, homePath: "/home",
    });
    assert.strictEqual(hit.restoredFrom, null);
    await writeBackIfClimbed(hit);
    assert.strictEqual(table.get(paneStateKey).lastPath, rememberedRow.lastPath, "no write on a plain hit");

    // A climb: the exact remembered directory is gone, but an ancestor still holds.
    const goneStoredRow = `${rememberedRow.lastPath}/gone`;
    const climb = await resolveOpeningDirectory({
        storedSessionPath: null, storedRow: goneStoredRow,
        probe: async (p) => p === rememberedRow.lastPath, homePath: "/home",
    });
    assert.strictEqual(climb.restoredFrom, goneStoredRow);
    await writeBackIfClimbed(climb);
    assert.strictEqual(table.get(paneStateKey).lastPath, climb.path, "the climb's landing path is written back");
});

test("the pane state model upserts on the composite key, not on the primary key", () => {
    const FilePaneState = require("../../models/FilePaneState");
    const unique = FilePaneState._indexes.filter((i) => i.unique).map((i) => i.fields.join(","));
    assert.ok(unique.includes("accountId,entryId,identityId"),
        "without this index on the model, upsert conflicts on `id` and every second write throws");
});

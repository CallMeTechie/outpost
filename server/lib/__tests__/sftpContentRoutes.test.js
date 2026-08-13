const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { PassThrough, Readable } = require("node:stream");
const express = require("express");

// sftp.js talks to the database (Session, Account, Entry) and to SessionManager /
// ConnectionService directly through `require`, not through injection. To characterize the
// route without a real database, we swap those modules in require.cache for in-memory fakes
// *before* sftp.js is first required, so its own `require(...)` calls resolve to the fakes.
// This mirrors the pattern in entryScope.test.js and identityAccessDenied.test.js.
//
// Two shapes of fake are used depending on how sftp.js consumes the module:
//   - Session / Account / Entry / SessionManager are used as `Module.method(...)`, i.e. the
//     module object itself is referenced at call time, so a fake object with methods closing
//     over a mutable Map is enough — no re-requiring needed between tests.
//   - createAuditLog and hasResourcePermission are pulled out with destructuring
//     (`const { hasResourcePermission } = require(...)`), which captures the function value at
//     load time. The fakes are therefore stable function references that read mutable state at
//     call time, so reassigning the exports object later would not be seen by sftp.js.

const sessionsByToken = new Map();
const accountsById = new Map();
const entriesById = new Map();
const serverSessionsById = new Map();
const connectionsById = new Map();

const sessionPath = require.resolve("../../models/Session");
require.cache[sessionPath] = {
    id: sessionPath, filename: sessionPath, loaded: true,
    exports: {
        findOne: async ({ where: { token } }) => sessionsByToken.get(token) ?? null,
        update: async () => [0],
    },
};

const accountPath = require.resolve("../../models/Account");
require.cache[accountPath] = {
    id: accountPath, filename: accountPath, loaded: true,
    exports: { findByPk: async (id) => accountsById.get(id) ?? null },
};

const entryPath = require.resolve("../../models/Entry");
require.cache[entryPath] = {
    id: entryPath, filename: entryPath, loaded: true,
    exports: { findByPk: async (id) => entriesById.get(id) ?? null },
};

const sessionManagerPath = require.resolve("../SessionManager");
require.cache[sessionManagerPath] = {
    id: sessionManagerPath, filename: sessionManagerPath, loaded: true,
    exports: {
        get: (sessionId) => serverSessionsById.get(sessionId) ?? null,
        getConnection: (sessionId) => connectionsById.get(sessionId) ?? null,
    },
};

const connectionServicePath = require.resolve("../ConnectionService");
require.cache[connectionServicePath] = {
    id: connectionServicePath, filename: connectionServicePath, loaded: true,
    exports: {
        // validateSession falls back to the master connection's client when this throws, so
        // resolving to the same client either way keeps both code paths behaviourally identical
        // for these tests — neither branch is itself under test here.
        getSFTPTransferClient: async (sessionId) => {
            const conn = connectionsById.get(sessionId);
            if (!conn?.sftpClient) throw new Error("no transfer client");
            return conn.sftpClient;
        },
    },
};

const auditPath = require.resolve("../../controllers/audit");
require.cache[auditPath] = {
    id: auditPath, filename: auditPath, loaded: true,
    exports: {
        createAuditLog: async () => {},
        AUDIT_ACTIONS: {
            FOLDER_CREATE: "folder.create", FILE_UPLOAD: "file.upload",
            FOLDER_DOWNLOAD: "folder.download", FILE_DOWNLOAD: "file.download",
        },
        RESOURCE_TYPES: { FOLDER: "folder", FILE: "file" },
    },
};

const permissionPath = require.resolve("../../utils/permission");
require.cache[permissionPath] = {
    id: permissionPath, filename: permissionPath, loaded: true,
    // None of the cases in this file exercise a denied hasResourcePermission check — the
    // brief's "Permission denied" case is the SFTP client's stat() rejecting with that message,
    // caught by sftp.js's own handleError. This fake always allows so requests reach the
    // sftpClient calls under test.
    exports: { hasResourcePermission: async () => true },
};

// Safe to load now: every DB- and session-manager-backed dependency sftp.js requires resolves
// to a fake installed above. The file under test is never modified.
const sftpRouter = require("../../routes/sftp");

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use("/api/entries/sftp", sftpRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/entries/sftp`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

let counter = 0;

// Wires up a session token + session id pair that validateSession will resolve to a working
// context backed by the given sftpClient double.
const registerSession = (sftpClient) => {
    counter += 1;
    const token = `token-${counter}`;
    const sessionId = `session-${counter}`;
    const accountId = counter;
    const entryId = counter * 100;

    sessionsByToken.set(token, { id: counter, accountId });
    accountsById.set(accountId, { id: accountId });
    entriesById.set(entryId, { id: entryId, organizationId: counter * 10 });
    serverSessionsById.set(sessionId, { accountId, entryId, connectionReason: null });
    connectionsById.set(sessionId, { sftpClient });

    return { sessionToken: token, sessionId };
};

const downloadUrl = (sessionToken, sessionId, path, extra = "") =>
    `${baseUrl}/?sessionToken=${sessionToken}&sessionId=${sessionId}&path=${encodeURIComponent(path)}${extra}`;

test("GET / with an existing file: 200, both filename forms, matching Content-Length and MIME type", async () => {
    const content = Buffer.from("hello world");
    const sftpClient = {
        stat: async () => ({ isDir: false, size: content.length }),
        readFile: () => ({ stream: Readable.from(content) }),
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);

    const res = await fetch(downloadUrl(sessionToken, sessionId, "/remote/report.txt"));
    const body = await res.text();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-length"), String(content.length));
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    const disposition = res.headers.get("content-disposition");
    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /filename="report\.txt"/);
    assert.match(disposition, /filename\*=UTF-8''report\.txt/);
    assert.strictEqual(body, "hello world");
});

test("GET / with preview=true: 200, Content-Disposition is inline", async () => {
    const content = Buffer.from("preview me");
    const sftpClient = {
        stat: async () => ({ isDir: false, size: content.length }),
        readFile: () => ({ stream: Readable.from(content) }),
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);

    const res = await fetch(downloadUrl(sessionToken, sessionId, "/remote/notes.txt", "&preview=true"));
    await res.text();

    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /^inline;/);
});

test("GET / for a file that does not exist: 404, Not found", async () => {
    const sftpClient = {
        stat: async () => { throw new Error("Path /remote/missing.txt does not exist"); },
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);

    const res = await fetch(downloadUrl(sessionToken, sessionId, "/remote/missing.txt"));
    const json = await res.json();

    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(json, { error: "Not found" });
});

test("GET / when the SFTP client reports Permission denied: 403, Permission denied", async () => {
    const sftpClient = {
        stat: async () => { throw new Error("Permission denied"); },
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);

    const res = await fetch(downloadUrl(sessionToken, sessionId, "/remote/secret.txt"));
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(json, { error: "Permission denied" });
});

test("GET / with thumbnail=true for a small image: 200, image/jpeg, cached", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    let thumbnailCalledWith = null;
    const sftpClient = {
        stat: async () => ({ isDir: false, size: 1024 }),
        thumbnail: async (path, size) => { thumbnailCalledWith = size; return { data: jpegBytes }; },
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);

    const res = await fetch(downloadUrl(sessionToken, sessionId, "/remote/photo.jpg", "&thumbnail=true"));
    const body = Buffer.from(await res.arrayBuffer());

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "image/jpeg");
    assert.strictEqual(res.headers.get("cache-control"), "public, max-age=3600");
    assert.deepStrictEqual(body, jpegBytes);
    assert.strictEqual(thumbnailCalledWith, 100, "default requested size should reach the client unchanged");
});

test("GET / thumbnail size outside 50-300 reaches sftpClient.thumbnail already clamped", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const seen = [];
    const sftpClient = {
        stat: async () => ({ isDir: false, size: 1024 }),
        thumbnail: async (path, size) => { seen.push(size); return { data: jpegBytes }; },
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);

    await fetch(downloadUrl(sessionToken, sessionId, "/remote/tiny.jpg", "&thumbnail=true&size=10"))
        .then((r) => r.arrayBuffer());
    await fetch(downloadUrl(sessionToken, sessionId, "/remote/huge.jpg", "&thumbnail=true&size=5000"))
        .then((r) => r.arrayBuffer());

    assert.deepStrictEqual(seen, [50, 300], "sizes below 50 and above 300 are clamped before reaching the client");
});

test("GET / for a folder: 200, Content-Disposition attachment with .zip", async () => {
    const sftpClient = {
        stat: async () => ({ isDir: true }),
        listDir: async () => [],
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);

    const res = await fetch(downloadUrl(sessionToken, sessionId, "/remote/pictures"));
    await res.arrayBuffer();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="pictures\.zip"$/);
});

test("POST /upload without a path: 400, Missing parameters", async () => {
    const res = await fetch(`${baseUrl}/upload?sessionToken=t&sessionId=s`, { method: "POST", body: "data" });
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(json, { error: "Missing parameters" });
});

test("POST /upload with a path containing '..': 400, Invalid path", async () => {
    const url = `${baseUrl}/upload?sessionToken=t&sessionId=s&path=${encodeURIComponent("/remote/../etc/passwd")}`;
    const res = await fetch(url, { method: "POST", body: "data" });
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(json, { error: "Invalid path" });
});

test("POST /upload success: 200, success/path/size", async () => {
    let writtenTo = null;
    const sftpClient = {
        mkdirRecursive: async () => [],
        writeFile: async (path) => { writtenTo = path; },
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);
    const payload = "the-uploaded-bytes";

    const url = `${baseUrl}/upload?sessionToken=${sessionToken}&sessionId=${sessionId}` +
        `&path=${encodeURIComponent("/remote/uploads/file.txt")}`;
    const res = await fetch(url, { method: "POST", body: payload });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(json, { success: true, path: "/remote/uploads/file.txt", size: payload.length });
    assert.strictEqual(writtenTo, "/remote/uploads/file.txt");
});

test("POST /multi with no paths: 400", async () => {
    const res = await fetch(`${baseUrl}/multi?sessionToken=t&sessionId=s`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
    });
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(json, { error: "No paths provided" });
});

test("POST /multi success: 200, zip Content-Disposition with nexterm-download- prefix", async () => {
    const content = Buffer.from("archived contents");
    const sftpClient = {
        stat: async () => ({ isDir: false }),
        readFile: () => ({ stream: Readable.from(content), totalSizePromise: Promise.resolve(content.length), done: Promise.resolve() }),
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);

    const res = await fetch(`${baseUrl}/multi?sessionToken=${sessionToken}&sessionId=${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `paths=${encodeURIComponent(JSON.stringify(["/remote/a.txt"]))}`,
    });
    await res.arrayBuffer();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="nexterm-download-.*\.zip"$/);
});

// Deliberate departure from what Task 1 characterized: this used to pin the response hanging
// forever on a mid-archive stream failure. The plan's Global Constraints (constraint 8) name that
// hang as a real bug and carve out this one exception — sftp.js now aborts the archive and destroys
// the response once the headers are already staged, instead of leaving the connection open forever.
test("GET / for a folder whose file stream errors mid-archive: the connection ends instead of hanging", async () => {
    // Modeled on EngineSftpClient.readFile's real error contract (server/lib/EngineSftpClient.js):
    // the stream gets a no-op "error" listener of its own, is destroyed with the error, and the
    // `done` promise REJECTS — it does not resolve quietly.
    const erroringReadFile = () => {
        const stream = new PassThrough();
        stream.on("error", () => {});
        let rejectDone;
        const done = new Promise((_resolve, reject) => { rejectDone = reject; });
        queueMicrotask(() => {
            stream.write("partial");
            queueMicrotask(() => {
                const err = new Error("connection reset mid-stream");
                stream.destroy(err);
                rejectDone(err);
            });
        });
        return { stream, totalSizePromise: Promise.resolve(7), done };
    };
    const sftpClient = {
        stat: async () => ({ isDir: true }),
        listDir: async () => [{ name: "big.bin", type: "file", isSymlink: false }],
        readFile: erroringReadFile,
    };
    const { sessionToken, sessionId } = registerSession(sftpClient);

    // `await done` rejects inside archiveFolder's loop as an ArchiveStreamError, which throws past
    // `archive.finalize()` in the route handler straight to its catch block. There, res.headersSent
    // is already true (Content-Disposition/Content-Type were staged before archiveFolder started),
    // so the route calls archive.abort() and res.destroy() instead of falling through to
    // handleError's silent no-op.
    //
    // Read off the running code rather than assumed: res.destroy() fires in the same microtask
    // turn as the staged header write, before Node has flushed that write to the socket, so
    // Socket#destroy discards it — the client never receives a byte, not even a status line, and
    // sees a hard connection reset rather than a clean response with a truncated body. Either way
    // the connection ends promptly instead of hanging, which is the one behaviour Task 1 pinned
    // as broken; a future change that makes this resolve into a normal response is also fine, a
    // regression to the old hang is not.
    const outcome = await Promise.race([
        fetch(downloadUrl(sessionToken, sessionId, "/remote/broken-folder"))
            .then(() => "completed", (err) => `errored: ${err.message}`),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 400)),
    ]);
    assert.notStrictEqual(outcome, "timed-out",
        "the connection must end — successfully or as a reset — rather than hang forever");
});

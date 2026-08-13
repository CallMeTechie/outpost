const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const { PassThrough, Readable } = require("node:stream");
const express = require("express");

// oneDriveContent.js talks to the database (Session, Account) and to the Microsoft connection
// table through `require`, not through injection — same shape as sftpContentRoutes.test.js, and
// for the same reason: swap those modules in require.cache for in-memory fakes *before*
// oneDriveContent.js (and the oneDriveWS.js / wsAuth.js it pulls in) is first required, so every
// `require(...)` inside resolves to the fake.
//
// The adapter itself is faked one layer further out: createOneDriveAdapter is replaced so each
// test can hand the route a stub with exactly the methods that test exercises, the same way the
// sftp characterization tests hand validateSession a stub sftpClient.

const sessionsByToken = new Map();
const accountsById = new Map();
const connectionsById = new Map();
const adaptersByConnectionId = new Map();

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

const microsoftConnectionPath = require.resolve("../../models/MicrosoftConnection");
require.cache[microsoftConnectionPath] = {
    id: microsoftConnectionPath, filename: microsoftConnectionPath, loaded: true,
    exports: { findOne: async ({ where: { id } }) => connectionsById.get(id) ?? null },
};

const oneDriveAdapterPath = require.resolve("../microsoft/oneDriveAdapter");
require.cache[oneDriveAdapterPath] = {
    id: oneDriveAdapterPath, filename: oneDriveAdapterPath, loaded: true,
    exports: {
        // The real factory takes { graph, connectionId } and builds a Graph-backed adapter; the
        // fake ignores `graph` entirely and hands back whatever stub the test registered for that
        // connection id, so a route under test never makes a network call.
        createOneDriveAdapter: ({ connectionId }) => adaptersByConnectionId.get(connectionId) ?? {},
    },
};

// Safe to load now: every DB- and adapter-backed dependency oneDriveContent.js requires (directly,
// or transitively through oneDriveWS.js / wsAuth.js) resolves to a fake installed above. The file
// under test, and the shared fileContent modules it drives, are never modified.
const oneDriveRouter = require("../../routes/oneDriveContent");
const { GraphError } = require("../microsoft/graphErrors");

let server;
let baseUrl;
let port;

test.before(async () => {
    const app = express();
    app.use("/api/entries/onedrive", oneDriveRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}/api/entries/onedrive`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

let counter = 0;

// Wires up a session token + connection id pair that resolveRequest will resolve to a working
// context backed by the given adapter double, owned by a fresh account each call.
const registerConnection = (adapter) => {
    counter += 1;
    const token = `token-${counter}`;
    const accountId = counter;
    const connectionId = counter;

    sessionsByToken.set(token, { id: counter, accountId });
    accountsById.set(accountId, { id: accountId });
    connectionsById.set(connectionId, { id: connectionId, accountId, status: "connected" });
    adaptersByConnectionId.set(connectionId, adapter);

    return { sessionToken: token, connectionId };
};

const contentUrl = (sessionToken, connectionId, path, extra = "") =>
    `${baseUrl}/?sessionToken=${sessionToken}&connectionId=${connectionId}&path=${encodeURIComponent(path)}${extra}`;

// --- Pure function: the close-code-to-status mapping -----------------------------------------

test("closeCodeToStatus maps 4008 to 400 and 4403 to 403, and defaults an unknown code to 400", () => {
    assert.strictEqual(oneDriveRouter.closeCodeToStatus(4008), 400);
    assert.strictEqual(oneDriveRouter.closeCodeToStatus(4403), 403);
    assert.strictEqual(oneDriveRouter.closeCodeToStatus(9999), 400);
});

// --- Authentication and connection resolution -------------------------------------------------

test("GET / without a sessionToken: 401, Invalid session", async () => {
    const res = await fetch(`${baseUrl}/?connectionId=1&path=${encodeURIComponent("/a.txt")}`);
    const json = await res.json();

    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(json, { error: "Invalid session" });
});

test("GET / with an unknown sessionToken: 401, Invalid session", async () => {
    const res = await fetch(`${baseUrl}/?sessionToken=nope&connectionId=1&path=${encodeURIComponent("/a.txt")}`);
    const json = await res.json();

    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(json, { error: "Invalid session" });
});

test("GET / with a valid session but no connectionId: 400", async () => {
    const { sessionToken } = registerConnection({});

    const res = await fetch(`${baseUrl}/?sessionToken=${sessionToken}&path=${encodeURIComponent("/a.txt")}`);
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.error, "Invalid connection ID");
});

test("GET / for a connection owned by a different account: 403, the response does not name the connection or the account", async () => {
    const { sessionToken } = registerConnection({});
    const foreignConnectionId = 900001;
    const foreignAccountId = 900002;
    connectionsById.set(foreignConnectionId, { id: foreignConnectionId, accountId: foreignAccountId, status: "connected" });

    const res = await fetch(contentUrl(sessionToken, foreignConnectionId, "/a.txt"));
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.ok(!json.error.includes(String(foreignConnectionId)), `error names the connection id: ${json.error}`);
    assert.ok(!json.error.includes(String(foreignAccountId)), `error names the account id: ${json.error}`);
});

test("GET / for a connection that does not exist: 403, same refusal as a foreign one", async () => {
    const { sessionToken } = registerConnection({});

    const res = await fetch(contentUrl(sessionToken, 8675309, "/a.txt"));
    const json = await res.json();

    assert.strictEqual(res.status, 403);
    assert.strictEqual(json.error, "This Microsoft connection is not available");
});

test("GET / with a malformed connectionId: 400, Invalid connection ID", async () => {
    const { sessionToken } = registerConnection({});

    const res = await fetch(`${baseUrl}/?sessionToken=${sessionToken}&connectionId=7abc&path=${encodeURIComponent("/a.txt")}`);
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.error, "Invalid connection ID");
});

// --- GET / (download, preview, thumbnail, folder-as-zip) ---------------------------------------

test("GET / for a missing path: 400, Missing parameters", async () => {
    const { sessionToken, connectionId } = registerConnection({});

    const res = await fetch(`${baseUrl}/?sessionToken=${sessionToken}&connectionId=${connectionId}`);
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(json, { error: "Missing parameters" });
});

test("GET / with a path containing '..': 400, Invalid path", async () => {
    const { sessionToken, connectionId } = registerConnection({});

    const res = await fetch(contentUrl(sessionToken, connectionId, "/a/../b"));
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(json, { error: "Invalid path" });
});

test("GET / with an existing file: 200, both filename forms, matching Content-Length and MIME type", async () => {
    const content = Buffer.from("hello world");
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => ({ type: "file", size: content.length }),
        readFile: () => ({ stream: Readable.from(content) }),
    });

    const res = await fetch(contentUrl(sessionToken, connectionId, "/remote/report.txt"));
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
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => ({ type: "file", size: content.length }),
        readFile: () => ({ stream: Readable.from(content) }),
    });

    const res = await fetch(contentUrl(sessionToken, connectionId, "/remote/notes.txt", "&preview=true"));
    await res.text();

    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /^inline;/);
});

test("GET / with thumbnail=true for a small image: 200, adapter's content type, cached, size clamped to the default", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    let thumbnailCalledWith = null;
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => ({ type: "file", size: 1024 }),
        thumbnail: async (path, size) => { thumbnailCalledWith = size; return { data: jpegBytes, contentType: "image/jpeg" }; },
    });

    const res = await fetch(contentUrl(sessionToken, connectionId, "/remote/photo.jpg", "&thumbnail=true"));
    const body = Buffer.from(await res.arrayBuffer());

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "image/jpeg");
    assert.strictEqual(res.headers.get("cache-control"), "public, max-age=3600");
    assert.deepStrictEqual(body, jpegBytes);
    assert.strictEqual(thumbnailCalledWith, 100, "default requested size should reach the adapter unchanged");
});

test("GET / thumbnail size outside 50-300 reaches adapter.thumbnail already clamped", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const seen = [];
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => ({ type: "file", size: 1024 }),
        thumbnail: async (path, size) => { seen.push(size); return { data: jpegBytes, contentType: "image/jpeg" }; },
    });

    await fetch(contentUrl(sessionToken, connectionId, "/remote/tiny.jpg", "&thumbnail=true&size=10")).then((r) => r.arrayBuffer());
    await fetch(contentUrl(sessionToken, connectionId, "/remote/huge.jpg", "&thumbnail=true&size=5000")).then((r) => r.arrayBuffer());

    assert.deepStrictEqual(seen, [50, 300], "sizes below 50 and above 300 are clamped before reaching the adapter");
});

test("GET / for a folder: 200, Content-Disposition attachment with .zip", async () => {
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => ({ type: "folder" }),
        listDir: async () => [],
    });

    const res = await fetch(contentUrl(sessionToken, connectionId, "/remote/pictures"));
    await res.arrayBuffer();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="pictures\.zip"$/);
});

// --- The Graph error mapping is the actual work of this task -----------------------------------

test("GET / for an item OneDrive reports missing: 404, the message keeps 'does not exist' (FileTransfer.js:45's NOT_FOUND match)", async () => {
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => { throw new GraphError("This item does not exist in OneDrive", { status: 404 }); },
    });

    const res = await fetch(contentUrl(sessionToken, connectionId, "/remote/missing.txt"));
    const json = await res.json();

    assert.strictEqual(res.status, 404);
    assert.match(json.error, /does not exist/);
});

test("GET / when Graph answers with a plain-text reason (e.g. no SharePoint licence): the sentence reaches the client verbatim, not 'request failed (400)'", async () => {
    const tenantMessage = "OneDrive refused the request: Tenant does not have a SPO license.";
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => { throw new GraphError(tenantMessage, { status: 400, code: "accessDenied" }); },
    });

    const res = await fetch(contentUrl(sessionToken, connectionId, "/remote/report.txt"));
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.error, tenantMessage);
});

test("GET / when the adapter throws a plain Error with no status: 500, generic message", async () => {
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => { throw new Error("boom"); },
    });

    const res = await fetch(contentUrl(sessionToken, connectionId, "/remote/report.txt"));
    const json = await res.json();

    assert.strictEqual(res.status, 500);
    assert.deepStrictEqual(json, { error: "boom" });
});

// --- POST /upload --------------------------------------------------------------------------

test("POST /upload without a path: 400, Missing parameters", async () => {
    const res = await fetch(`${baseUrl}/upload?sessionToken=t&connectionId=1`, { method: "POST", body: "data" });
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(json, { error: "Missing parameters" });
});

test("POST /upload with a path containing '..': 400, Invalid path", async () => {
    const url = `${baseUrl}/upload?sessionToken=t&connectionId=1&path=${encodeURIComponent("/remote/../etc/passwd")}`;
    const res = await fetch(url, { method: "POST", body: "data" });
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(json, { error: "Invalid path" });
});

test("POST /upload success: 200, success/path/size, size and stream both reach writeFile", async () => {
    let writtenTo = null;
    let writtenOptions = null;
    const { sessionToken, connectionId } = registerConnection({
        writeFile: async (path, source, options) => { writtenTo = path; writtenOptions = options; source.resume(); },
    });
    const payload = "the-uploaded-bytes";

    const url = `${baseUrl}/upload?sessionToken=${sessionToken}&connectionId=${connectionId}` +
        `&path=${encodeURIComponent("/remote/uploads/file.txt")}`;
    const res = await fetch(url, { method: "POST", body: payload });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(json, { success: true, path: "/remote/uploads/file.txt", size: payload.length });
    assert.strictEqual(writtenTo, "/remote/uploads/file.txt");
    assert.strictEqual(writtenOptions.size, payload.length, "the size hint must reach writeFile, not just the response");
});

// The brief's third distinguishing point: without a Content-Length header there is nothing to pick
// the chunked-vs-simple upload path by, and Graph's Content-Range needs the total up front — so
// the route refuses before ever calling writeFile, rather than starting a stream that fails midway.
test("POST /upload without a Content-Length header: 411, its own message, writeFile is never called", async () => {
    let called = false;
    const { sessionToken, connectionId } = registerConnection({
        writeFile: async () => { called = true; },
    });

    const path = `/api/entries/onedrive/upload?sessionToken=${sessionToken}&connectionId=${connectionId}` +
        `&path=${encodeURIComponent("/remote/uploads/file.txt")}`;

    const result = await new Promise((resolve, reject) => {
        // fetch() (and any client that knows its body up front) sets Content-Length itself, so a
        // raw socket is the only way to send a POST body without the header this route is meant
        // to guard against. Chunked transfer-encoding is what Node falls back to here, which is
        // exactly the shape a slow or streaming client would produce in practice.
        const req = http.request({ hostname: "127.0.0.1", port, method: "POST", path }, (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on("error", reject);
        req.write("hello");
        req.end();
    });

    assert.strictEqual(result.status, 411);
    assert.deepStrictEqual(result.body, { error: "A content length is required" });
    assert.strictEqual(called, false, "writeFile must not be attempted without a size to give it");
});

test("POST /upload when Graph rejects the write: the adapter's status and message reach the client", async () => {
    const { sessionToken, connectionId } = registerConnection({
        writeFile: async () => { throw new GraphError("Your OneDrive is full", { status: 507 }); },
    });

    const url = `${baseUrl}/upload?sessionToken=${sessionToken}&connectionId=${connectionId}` +
        `&path=${encodeURIComponent("/remote/uploads/file.txt")}`;
    const res = await fetch(url, { method: "POST", body: "data" });
    const json = await res.json();

    assert.strictEqual(res.status, 507);
    assert.deepStrictEqual(json, { error: "Your OneDrive is full" });
});

// --- POST /multi ---------------------------------------------------------------------------

test("POST /multi with no paths: 400", async () => {
    const res = await fetch(`${baseUrl}/multi?sessionToken=t&connectionId=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
    });
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(json, { error: "No paths provided" });
});

test("POST /multi with a path containing '..': 400, Invalid path", async () => {
    const res = await fetch(`${baseUrl}/multi?sessionToken=t&connectionId=1`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `paths=${encodeURIComponent(JSON.stringify(["/a/../b"]))}`,
    });
    const json = await res.json();

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(json, { error: "Invalid path" });
});

test("POST /multi success: 200, zip Content-Disposition with nexterm-download- prefix", async () => {
    const content = Buffer.from("archived contents");
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => ({ type: "file" }),
        readFile: () => ({ stream: Readable.from(content), totalSizePromise: Promise.resolve(content.length), done: Promise.resolve() }),
    });

    const res = await fetch(`${baseUrl}/multi?sessionToken=${sessionToken}&connectionId=${connectionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `paths=${encodeURIComponent(JSON.stringify(["/remote/a.txt"]))}`,
    });
    await res.arrayBuffer();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="nexterm-download-.*\.zip"$/);
});

// Mirrors sftp.js's own characterization of the same failure mode (sftpContentRoutes.test.js): a
// stream that fails AFTER archive.append() ran must not leave the response hanging once headers
// are already staged. archive.js's ArchiveStreamError propagates out of archiveFolder the same way
// for either adapter — this test exists to prove oneDriveContent.js's catch handles it the same
// way sftp.js's does, not to re-test archive.js itself.
test("GET / for a folder whose file stream errors mid-archive: the connection ends instead of hanging", async () => {
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
    const { sessionToken, connectionId } = registerConnection({
        stat: async () => ({ type: "folder" }),
        listDir: async () => [{ name: "big.bin", type: "file", isSymlink: false }],
        readFile: erroringReadFile,
    });

    const url = new URL(contentUrl(sessionToken, connectionId, "/remote/broken-folder"));
    const outcome = await new Promise((resolve) => {
        const socket = net.connect(Number(url.port), url.hostname, () => {
            socket.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
        });
        let received = Buffer.alloc(0);
        const timer = setTimeout(() => resolve({ kind: "timed-out", received }), 400);
        socket.on("data", (chunk) => { received = Buffer.concat([received, chunk]); });
        socket.on("error", () => {});
        socket.on("close", () => { clearTimeout(timer); resolve({ kind: "closed", received }); });
    });

    assert.strictEqual(outcome.kind, "closed",
        "the connection must close on its own — with or without a partial response — rather than hang forever");

    if (outcome.received.length > 0) {
        const head = outcome.received.toString("latin1");
        assert.match(head, /^HTTP\/1\.1 200/, "if any bytes reached the client, the status must be the one already committed before the stream error");
        assert.match(head, /content-type: application\/zip/i, "if any bytes reached the client, Content-Type must be the one already committed");
    }
});

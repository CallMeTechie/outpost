const test = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const { FileTransfer } = require("../fileTransfer/FileTransfer");
const { createGraphClient, GRAPH_BASE } = require("../microsoft/graphClient");
const { createOneDriveAdapter } = require("../microsoft/oneDriveAdapter");

// Everything between FileTransfer and the socket is the real thing here: the real transfer engine
// over the real adapter over the real graph client, with only fetch replaced. That is the point of
// this file. graphErrors translates a 404 into a sentence, and FileTransfer decides what counts as
// "not found" by matching that sentence against NOT_FOUND (FileTransfer.js:45) — two modules that
// never import each other. A unit test on either side is happy while the seam between them is
// broken: the wording drifted to "no longer exists" once, and every OneDrive transfer died on the
// destination stat of its very first file, before a byte moved.
const STAMP = "2026-08-12T18:00:00Z";

const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    json: async () => {
        if (body === null) throw new Error("no body");
        return body;
    },
});

const gone = () => reply(404, { error: { code: "itemNotFound", message: "The resource could not be found." } });

const clientOver = (fetchImpl) => createGraphClient({
    getAccessToken: async () => "tok",
    forgetToken: () => {},
    fetchImpl,
    sleep: async () => {},
    random: () => 0.5,
});

// The address Graph was asked about, with the query string and the base stripped off.
const addressed = (url) => url.slice(GRAPH_BASE.length).split("?")[0];

const memorySource = (contents) => ({
    listDir: async () => [],
    stat: async (path) => {
        if (!(path in contents)) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
        return { size: contents[path].length, type: "file", mtime: 1, isSymlink: false };
    },
    readFile: (path) => {
        const stream = new PassThrough();
        setImmediate(() => stream.end(Buffer.from(contents[path])));
        return { stream, done: Promise.resolve() };
    },
    unlink: async () => undefined,
    rmdir: async () => undefined,
});

const memoryDest = (written) => ({
    listDir: async () => [],
    stat: async (path) => {
        if (!written.has(path)) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
        return { size: written.get(path).length, type: "file", mtime: 1, isSymlink: false };
    },
    writeFile: async (path, stream) => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        written.set(path, Buffer.concat(chunks));
    },
    mkdirRecursive: async () => undefined,
    unlink: async (path) => { written.delete(path); },
    rmdir: async () => undefined,
});

// A first transfer into a folder answers 404 to every destination stat there is — _resolveConflict
// runs one per file and treats anything but not-found as fatal. If the 404 does not read as
// not-found, nothing OneDrive is the destination of can ever complete.
test("a OneDrive destination completes a file whose target does not exist yet", async () => {
    const stored = new Map();

    const graph = clientOver(async (url, options = {}) => {
        const method = options.method || "GET";
        const path = addressed(url);

        if (method === "PUT" && path.endsWith("/content")) {
            const item = path.slice(0, -"/content".length);
            stored.set(item, Buffer.from(options.body));
            return reply(200, { name: "hallo.txt", file: {}, size: options.body.length, lastModifiedDateTime: STAMP });
        }

        if (method === "GET") {
            const held = stored.get(path);
            if (held === undefined) return gone();
            return reply(200, { name: "hallo.txt", file: {}, size: held.length, lastModifiedDateTime: STAMP });
        }

        throw new Error(`the transfer made an unexpected ${method} to ${url}`);
    });

    const transfer = new FileTransfer({
        source: memorySource({ "/hallo.txt": "hallo welt" }),
        dest: createOneDriveAdapter({ graph, connectionId: 1 }),
    });

    const result = await transfer.run(["/hallo.txt"], "/Ziel");

    assert.strictEqual(result.cancelled, false);
    assert.strictEqual(result.filesTransferred, 1, "the transfer must get past the destination stat");
    assert.strictEqual(result.filesSkipped, 0);
    assert.strictEqual(stored.get("/root:/Ziel/hallo.txt:")?.toString(), "hallo welt",
        "and the bytes must actually arrive at OneDrive");
});

// The same wording, read from the other side: a source file that disappeared between the walk and
// the read is a skip, and a transfer of many files must survive it. Without the match it becomes a
// hard failure that takes the whole run down.
test("a OneDrive source file that vanished after the walk is skipped, not fatal", async () => {
    const graph = clientOver(async (url) => (addressed(url).endsWith("/content")
        ? gone()
        : reply(200, { name: "weg.txt", file: {}, size: 10, lastModifiedDateTime: STAMP })));

    const written = new Map();
    const transfer = new FileTransfer({
        source: createOneDriveAdapter({ graph, connectionId: 1 }),
        dest: memoryDest(written),
    });

    const result = await transfer.run(["/weg.txt"], "/Ziel");

    assert.strictEqual(result.cancelled, false);
    assert.strictEqual(result.filesTransferred, 0);
    assert.strictEqual(result.filesSkipped, 1, "a vanished source file must not fail the whole transfer");
});

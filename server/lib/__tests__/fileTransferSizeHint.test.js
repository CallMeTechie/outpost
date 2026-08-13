const test = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const { FileTransfer } = require("../fileTransfer/FileTransfer");

const notFound = () => Object.assign(new Error("no such file"), { code: "ENOENT" });

const source = (contents) => ({
    listDir: async () => [],
    stat: async (path) => {
        if (!(path in contents)) throw notFound();
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

// Graph needs the total length in every chunk's Content-Range, and the only place that knows it
// before the first byte moves is FileTransfer — it stat()ed the source to build the plan.
test("the destination is told how large the file will be", async () => {
    const seen = [];
    const written = {};

    const dest = {
        listDir: async () => [],
        stat: async (path) => {
            if (path in written) return { size: written[path].length, type: "file", mtime: 1, isSymlink: false };
            throw notFound();
        },
        writeFile: async (path, stream, options) => {
            seen.push({ path, options });
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            written[path] = Buffer.concat(chunks);
        },
        mkdirRecursive: async () => undefined,
        unlink: async () => undefined,
        rmdir: async () => undefined,
    };

    const transfer = new FileTransfer({ source: source({ "/a.txt": "hallo" }), dest });
    await transfer.run(["/a.txt"], "/ziel");

    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].options, { size: 5 },
        "without the size a OneDrive destination cannot open an upload session");
});

// The SFTP adapter takes two parameters and must stay untouched by the third.
test("a destination that ignores the hint still works", async () => {
    const written = {};

    const dest = {
        listDir: async () => [],
        stat: async (path) => {
            if (path in written) return { size: written[path].length, type: "file", mtime: 1, isSymlink: false };
            throw notFound();
        },
        writeFile: async (path, stream) => {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            written[path] = Buffer.concat(chunks);
        },
        mkdirRecursive: async () => undefined,
        unlink: async () => undefined,
        rmdir: async () => undefined,
    };

    const transfer = new FileTransfer({ source: source({ "/b.txt": "welt" }), dest });
    await transfer.run(["/b.txt"], "/ziel");

    assert.strictEqual(written["/ziel/b.txt"].toString(), "welt");
});

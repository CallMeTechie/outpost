const test = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const { FileTransfer } = require("../fileTransfer/FileTransfer");

const notFound = () => {
    const err = new Error("no such file");
    err.code = "ENOENT";
    return err;
};

const fakeSource = (tree, stats, contents = {}) => ({
    listDir: async (path) => tree[path] ?? [],
    stat: async (path) => {
        if (!(path in stats)) throw notFound();
        return stats[path];
    },
    readFile: (path) => {
        const stream = new PassThrough();
        setImmediate(() => stream.end(Buffer.from(contents[path] ?? "")));
        return { stream, done: Promise.resolve() };
    },
    unlink: async () => undefined,
    rmdir: async () => undefined,
});

const fakeDest = (existing = {}) => {
    const written = {};
    const created = [];
    const removed = [];
    return {
        written, created, removed,
        listDir: async () => [],
        stat: async (path) => {
            if (path in existing) return existing[path];
            if (path in written) return { size: written[path].length, type: "file", mtime: 1, isSymlink: false };
            throw notFound();
        },
        writeFile: async (path, source) => {
            const chunks = [];
            for await (const chunk of source) chunks.push(chunk);
            written[path] = Buffer.concat(chunks).toString();
        },
        mkdirRecursive: async (path) => { created.push(path); return []; },
        unlink: async (path) => { removed.push(path); delete written[path]; },
        rmdir: async () => undefined,
    };
};

const oneFile = (content = "hello") =>
    fakeSource({}, { "/srv/a.txt": { size: content.length, type: "file", mtime: 1 } }, { "/srv/a.txt": content });

test("copies a single file and reports progress", async () => {
    const dest = fakeDest();
    const progress = [];
    const transfer = new FileTransfer({ source: oneFile(), dest, onProgress: (p) => progress.push(p) });

    const result = await transfer.run(["/srv/a.txt"], "/target");

    assert.strictEqual(dest.written["/target/a.txt"], "hello");
    assert.strictEqual(result.filesTransferred, 1);
    assert.strictEqual(result.cancelled, false);
    assert.strictEqual(progress.at(-1).filesDone, 1);
    assert.strictEqual(progress.at(-1).bytesTotal, 5);
});

// The spec requires filesTotal to be final from the first frame on.
test("the first progress frame already reports the final totals", async () => {
    const dest = fakeDest();
    const progress = [];
    const transfer = new FileTransfer({ source: oneFile(), dest, onProgress: (p) => progress.push(p) });

    await transfer.run(["/srv/a.txt"], "/target");

    assert.strictEqual(progress[0].filesTotal, 1);
    assert.strictEqual(progress[0].bytesTotal, 5);
});

test("creates target directories before writing files", async () => {
    const source = fakeSource(
        { "/srv/data": [{ name: "x.txt", type: "file", size: 2, mtime: 1, isSymlink: false, mode: 33188 }] },
        { "/srv/data": { size: 0, type: "folder", mtime: 1 } },
        { "/srv/data/x.txt": "hi" },
    );
    const dest = fakeDest();
    await new FileTransfer({ source, dest }).run(["/srv/data"], "/target");

    assert.deepStrictEqual(dest.created, ["/target/data"]);
    assert.strictEqual(dest.written["/target/data/x.txt"], "hi");
});

test("known parent directories are not created twice", async () => {
    const source = fakeSource(
        {
            "/srv/data": [{ name: "sub", type: "folder", size: 0, mtime: 1, isSymlink: false, mode: 16877 }],
            "/srv/data/sub": [],
        },
        { "/srv/data": { size: 0, type: "folder", mtime: 1 } },
    );
    const dest = fakeDest();
    await new FileTransfer({ source, dest }).run(["/srv/data"], "/target");

    assert.strictEqual(new Set(dest.created).size, dest.created.length, "no directory may be created twice");
});

test("a file where a target directory belongs is a type conflict", async () => {
    const source = fakeSource(
        { "/srv/data": [{ name: "x.txt", type: "file", size: 2, mtime: 1, isSymlink: false, mode: 33188 }] },
        { "/srv/data": { size: 0, type: "folder", mtime: 1 } },
        { "/srv/data/x.txt": "hi" },
    );
    const dest = fakeDest({ "/target/data": { size: 3, type: "file", mtime: 1, isSymlink: false } });

    await assert.rejects(() => new FileTransfer({ source, dest }).run(["/srv/data"], "/target"),
        /different type: \/target\/data/);
});

test("skipped symlinks are counted, not transferred", async () => {
    const source = fakeSource(
        { "/srv/data": [{ name: "link", type: "file", size: 9, mtime: 1, isSymlink: true, mode: 41471 }] },
        { "/srv/data": { size: 0, type: "folder", mtime: 1 } },
    );
    const result = await new FileTransfer({ source, dest: fakeDest() }).run(["/srv/data"], "/target");

    assert.strictEqual(result.filesSkipped, 1);
    assert.strictEqual(result.filesTransferred, 0);
});

test("a failing file removes its partial target and stops the transfer", async () => {
    const dest = fakeDest();
    dest.writeFile = async () => { throw new Error("disk full"); };

    await assert.rejects(() => new FileTransfer({ source: oneFile(), dest }).run(["/srv/a.txt"], "/target"),
        /disk full/);
    assert.deepStrictEqual(dest.removed, ["/target/a.txt"]);
});

test("partial files are removed via destCleanup, not via dest", async () => {
    const cleanup = { removed: [], unlink: async (p) => { cleanup.removed.push(p); } };
    const dest = fakeDest();
    dest.writeFile = async () => { throw new Error("disk full"); };

    await assert.rejects(
        () => new FileTransfer({ source: oneFile(), dest, destCleanup: cleanup }).run(["/srv/a.txt"], "/target"),
        /disk full/);
    assert.deepStrictEqual(cleanup.removed, ["/target/a.txt"]);
    assert.deepStrictEqual(dest.removed, []);
});

test("an undeletable partial file is reported by path", async () => {
    const dest = fakeDest();
    dest.writeFile = async () => { throw new Error("disk full"); };
    dest.unlink = async () => { throw new Error("connection gone"); };

    const err = await new FileTransfer({ source: oneFile(), dest })
        .run(["/srv/a.txt"], "/target").then(() => null, (e) => e);

    assert.match(err.message, /disk full/);
    assert.deepStrictEqual(err.leftovers, ["/target/a.txt"]);
});

// The spec wants this case skipped, not fatal — it is the likeliest failure in a long transfer.
test("a source file that vanished after the walk is skipped, not fatal", async () => {
    const source = oneFile();
    source.readFile = () => { throw notFound(); };
    const dest = fakeDest();

    const result = await new FileTransfer({ source, dest }).run(["/srv/a.txt"], "/target");

    assert.strictEqual(result.filesSkipped, 1);
    assert.strictEqual(result.filesTransferred, 0);
});

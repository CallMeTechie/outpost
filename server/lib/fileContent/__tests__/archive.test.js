const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");
const { archiveFolder, archiveItems } = require("../archive");

// An archive that only records what it would have received.
const fakeArchive = () => {
    const appended = [];
    return { appended, append: (source, opts) => appended.push({ source, name: opts.name }) };
};

const fileStream = (text) => Readable.from([Buffer.from(text)]);

// tree: { "/a": [entries], … } as listDir would report them; files: { "/a/x.txt": "content" }
const fakeAdapter = ({ tree = {}, files = {} } = {}) => ({
    listDir: async (path) => tree[path] ?? [],
    stat: async (path) => (tree[path]
        ? { type: "folder", size: 0 }
        : { type: "file", size: (files[path] ?? "").length }),
    readFile: (path) => ({ stream: fileStream(files[path] ?? ""), done: Promise.resolve() }),
});

test("a flat folder appends every file under its base path", async () => {
    const adapter = fakeAdapter({
        tree: { "/src": [{ name: "a.txt", type: "file" }, { name: "b.txt", type: "file" }] },
        files: { "/src/a.txt": "A", "/src/b.txt": "B" },
    });
    const archive = fakeArchive();
    await archiveFolder(adapter, archive, "/src", "src");
    assert.deepStrictEqual(archive.appended.map((e) => e.name), ["src/a.txt", "src/b.txt"]);
});

test("nested folders keep their structure", async () => {
    const adapter = fakeAdapter({
        tree: {
            "/src": [{ name: "deep", type: "folder" }],
            "/src/deep": [{ name: "c.txt", type: "file" }],
        },
        files: { "/src/deep/c.txt": "C" },
    });
    const archive = fakeArchive();
    await archiveFolder(adapter, archive, "/src", "src");
    assert.deepStrictEqual(archive.appended.map((e) => e.name), ["src/deep/c.txt"]);
});

// Without this branch, an empty folder vanishes from the archive without a trace.
test("an empty folder is appended as a directory entry", async () => {
    const adapter = fakeAdapter({ tree: { "/empty": [] } });
    const archive = fakeArchive();
    await archiveFolder(adapter, archive, "/empty", "empty");
    assert.deepStrictEqual(archive.appended.map((e) => e.name), ["empty/"]);
});

test("symlinks are skipped", async () => {
    const adapter = fakeAdapter({
        tree: { "/src": [{ name: "link", type: "file", isSymlink: true }, { name: "real.txt", type: "file" }] },
        files: { "/src/real.txt": "R" },
    });
    const archive = fakeArchive();
    await archiveFolder(adapter, archive, "/src", "src");
    assert.deepStrictEqual(archive.appended.map((e) => e.name), ["src/real.txt"]);
});

test("a path at the root does not gain a double slash", async () => {
    const adapter = fakeAdapter({
        tree: { "/": [{ name: "top.txt", type: "file" }] },
        files: { "/top.txt": "T" },
    });
    const archive = fakeArchive();
    await archiveFolder(adapter, archive, "/", "");
    assert.deepStrictEqual(archive.appended.map((e) => e.name), ["top.txt"]);
});

// The reason engineSftpAdapter now passes the field through: without the wait, the engine
// doesn't have the size yet, and the archive would get a stream that doesn't know it either.
test("totalSizePromise is awaited when the adapter offers one, and not required when it does not", async () => {
    const order = [];
    const adapter = fakeAdapter({ tree: { "/src": [{ name: "a.txt", type: "file" }] }, files: { "/src/a.txt": "A" } });
    const withSize = {
        ...adapter,
        readFile: () => ({
            stream: fileStream("A"),
            done: Promise.resolve(),
            totalSizePromise: Promise.resolve(1).then((v) => { order.push("size"); return v; }),
        }),
    };
    const archive = { append: () => order.push("append") };
    await archiveFolder(withSize, archive, "/src", "src");
    assert.deepStrictEqual(order, ["size", "append"]);

    // And without the field, it still goes through.
    const plain = fakeArchive();
    await archiveFolder(adapter, plain, "/src", "src");
    assert.strictEqual(plain.appended.length, 1);
});

test("archiveItems handles a mixed selection of files and folders", async () => {
    const adapter = fakeAdapter({
        tree: { "/dir": [{ name: "x.txt", type: "file" }] },
        files: { "/dir/x.txt": "X", "/loose.txt": "L" },
    });
    const archive = fakeArchive();
    await archiveItems(adapter, archive, ["/loose.txt", "/dir"]);
    assert.deepStrictEqual(archive.appended.map((e) => e.name), ["loose.txt", "dir/x.txt"]);
});

// Without this catch, a single unreadable entry would abort the whole archive.
test("an entry that cannot be read is skipped, the rest still lands", async () => {
    const adapter = fakeAdapter({ files: { "/ok.txt": "O" } });
    const failing = {
        ...adapter,
        stat: async (path) => {
            if (path === "/bad.txt") throw new Error("does not exist");
            return { type: "file", size: 1 };
        },
    };
    const archive = fakeArchive();
    await archiveItems(failing, archive, ["/bad.txt", "/ok.txt"]);
    assert.deepStrictEqual(archive.appended.map((e) => e.name), ["ok.txt"]);
});

// An entry that cannot be opened at all is skipped — the archive stays usable. A stream that
// fails partway through has already written bytes, though: the archive is unusable from that
// point on, and the caller must find out instead of waiting on a finalize() that never comes.
test("a stream that fails after it started propagates instead of being swallowed", async () => {
    const adapter = {
        listDir: async () => [{ name: "a.txt", type: "file" }],
        stat: async () => ({ type: "file", size: 1 }),
        readFile: () => ({
            stream: Readable.from([Buffer.from("A")]),
            done: Promise.reject(new Error("stream died mid-flight")),
        }),
    };
    await assert.rejects(
        () => archiveFolder(adapter, { append: () => {} }, "/src", "src"),
        /stream died mid-flight/,
    );
});

// The same escape hatch reached through archiveItems: a mid-selection stream failure must not be
// caught by the per-path try/catch that exists for entries which never opened. If it were, the
// multi-select download would hang the same way the single-folder one did before this fix.
test("a stream that fails mid-archive inside a multi-selection propagates out of archiveItems", async () => {
    const adapter = {
        listDir: async () => [],
        stat: async () => ({ type: "file", size: 1 }),
        readFile: () => ({
            stream: Readable.from([Buffer.from("A")]),
            done: Promise.reject(new Error("stream died mid-flight")),
        }),
    };
    await assert.rejects(
        () => archiveItems(adapter, { append: () => {} }, ["/broken.txt"]),
        /stream died mid-flight/,
    );
});

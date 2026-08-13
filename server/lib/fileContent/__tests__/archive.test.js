const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");
const { archiveFolder, archiveItems } = require("../archive");

// Ein Archiv, das nur mitschreibt, was es bekommen hätte.
const fakeArchive = () => {
    const appended = [];
    return { appended, append: (source, opts) => appended.push({ source, name: opts.name }) };
};

const fileStream = (text) => Readable.from([Buffer.from(text)]);

// tree: { "/a": [entries], … } wie listDir sie liefert; files: { "/a/x.txt": "inhalt" }
const fakeAdapter = ({ tree = {}, files = {}, sizePromise = false } = {}) => ({
    listDir: async (path) => tree[path] ?? [],
    stat: async (path) => (tree[path]
        ? { type: "folder", size: 0 }
        : { type: "file", size: (files[path] ?? "").length }),
    readFile: (path) => {
        const base = { stream: fileStream(files[path] ?? ""), done: Promise.resolve() };
        return sizePromise ? { ...base, totalSizePromise: Promise.resolve((files[path] ?? "").length) } : base;
    },
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

// Ohne diesen Zweig verschwindet ein leerer Ordner spurlos aus dem Archiv.
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

// Der Grund, warum engineSftpAdapter das Feld künftig durchreicht: ohne das Warten hat die
// Engine die Größe noch nicht, und das Archiv bekäme einen Strom, der noch nichts weiß.
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

    // Und ohne das Feld läuft es trotzdem durch.
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

// Ohne diesen Fang bricht ein einziger unlesbarer Eintrag das ganze Archiv ab.
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

// Ein Eintrag, den man gar nicht öffnen kann, wird übersprungen — das Archiv bleibt brauchbar.
// Ein Strom, der mittendrin abbricht, hat dagegen schon Bytes geschrieben: Das Archiv ist ab da
// unbrauchbar, und der Aufrufer muss davon erfahren, statt auf ein finalize() zu warten, das
// nie kommt.
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

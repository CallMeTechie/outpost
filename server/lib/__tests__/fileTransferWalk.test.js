const test = require("node:test");
const assert = require("node:assert");
const { walk } = require("../fileTransfer/walk");

const fakeSource = (tree, stats) => ({
    listDir: async (path) => {
        if (!(path in tree)) throw new Error(`no such directory: ${path}`);
        return tree[path];
    },
    stat: async (path) => {
        if (!(path in stats)) throw new Error(`no such path: ${path}`);
        return stats[path];
    },
});

const file = (name, extra = {}) => ({ name, type: "file", size: 1, mtime: 1, isSymlink: false, mode: 33188, ...extra });
const dir = (name, extra = {}) => ({ name, type: "folder", size: 0, mtime: 1, isSymlink: false, mode: 16877, ...extra });

test("a single file yields one entry and no directories", async () => {
    const source = fakeSource({}, { "/srv/a.txt": { size: 10, type: "file", mtime: 1 } });
    const result = await walk(source, ["/srv/a.txt"]);

    assert.deepStrictEqual(result.files, [{ srcPath: "/srv/a.txt", relPath: "a.txt", size: 10, mtime: 1 }]);
    assert.deepStrictEqual(result.dirs, []);
    assert.deepStrictEqual(result.topLevelFolders, []);
    assert.strictEqual(result.totalBytes, 10);
});

test("a folder is walked recursively, parents before children", async () => {
    const source = fakeSource(
        {
            "/srv/data": [dir("sub"), file("top.txt", { size: 5 })],
            "/srv/data/sub": [file("deep.txt", { size: 7 })],
        },
        { "/srv/data": { size: 0, type: "folder", mtime: 1 } },
    );

    const result = await walk(source, ["/srv/data"]);

    assert.deepStrictEqual(result.dirs.map((d) => d.relPath), ["data", "data/sub"]);
    assert.deepStrictEqual(result.files.map((f) => f.relPath).sort(), ["data/sub/deep.txt", "data/top.txt"]);
    assert.deepStrictEqual(result.topLevelFolders, ["/srv/data"]);
    assert.strictEqual(result.totalBytes, 12);
});

test("symlinks are skipped and never followed", async () => {
    const source = fakeSource(
        { "/srv/data": [dir("link", { isSymlink: true }), file("real.txt", { size: 3 })] },
        { "/srv/data": { size: 0, type: "folder", mtime: 1 } },
    );

    const result = await walk(source, ["/srv/data"]);

    assert.deepStrictEqual(result.skipped, [{ path: "/srv/data/link", relPath: "data/link", reason: "symlink" }]);
    assert.deepStrictEqual(result.files.map((f) => f.relPath), ["data/real.txt"]);
});

// isSymlink comes from free-form server text; mode is the second source of truth.
test("an entry whose mode says symlink is skipped even when isSymlink is false", async () => {
    const source = fakeSource(
        { "/srv/data": [file("sneaky", { isSymlink: false, mode: 0o120777 })] },
        { "/srv/data": { size: 0, type: "folder", mtime: 1 } },
    );

    const result = await walk(source, ["/srv/data"]);
    assert.strictEqual(result.skipped.length, 1);
    assert.deepStrictEqual(result.files, []);
});

test("a name from the source server can never escape the destination", async () => {
    const source = fakeSource(
        { "/srv/data": [file("../../root/.ssh/authorized_keys")] },
        { "/srv/data": { size: 0, type: "folder", mtime: 1 } },
    );
    await assert.rejects(() => walk(source, ["/srv/data"]), /unsafe file name/i);
});

test("control characters in a name are rejected", async () => {
    const source = fakeSource(
        { "/srv/data": [file("evil\nname")] },
        { "/srv/data": { size: 0, type: "folder", mtime: 1 } },
    );
    await assert.rejects(() => walk(source, ["/srv/data"]), /unsafe file name/i);
});

test("a tree that never ends is rejected instead of exhausting memory", async () => {
    const source = {
        listDir: async () => [dir("deeper")],
        stat: async () => ({ size: 0, type: "folder", mtime: 1 }),
    };
    await assert.rejects(() => walk(source, ["/srv/loop"]), /too deep/i);
});

test("the walk stops when the transfer was cancelled", async () => {
    const source = {
        listDir: async () => [dir("deeper")],
        stat: async () => ({ size: 0, type: "folder", mtime: 1 }),
    };
    await assert.rejects(() => walk(source, ["/srv/loop"], { isCancelled: () => true }), /cancelled/i);
});

test("two top level paths with the same name are rejected", async () => {
    const source = fakeSource({}, {
        "/srv/a/notes.txt": { size: 4, type: "file", mtime: 1 },
        "/srv/b/notes.txt": { size: 4, type: "file", mtime: 1 },
    });
    await assert.rejects(() => walk(source, ["/srv/a/notes.txt", "/srv/b/notes.txt"]), /ambiguous/i);
});

test("a source path that no longer exists is reported by path", async () => {
    const source = fakeSource({}, {});
    await assert.rejects(() => walk(source, ["/srv/gone.txt"]), /\/srv\/gone\.txt/);
});

test("an empty folder still produces its directory entry", async () => {
    const source = fakeSource({ "/srv/empty": [] }, { "/srv/empty": { size: 0, type: "folder", mtime: 1 } });
    const result = await walk(source, ["/srv/empty"]);

    assert.deepStrictEqual(result.dirs.map((d) => d.relPath), ["empty"]);
    assert.deepStrictEqual(result.files, []);
});

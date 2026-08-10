const test = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const { FileTransfer } = require("../fileTransfer/FileTransfer");

const notFound = () => { const e = new Error("no such file"); e.code = "ENOENT"; return e; };

const hangingSource = (unlinked) => ({
    unlinked,
    listDir: async () => [],
    stat: async () => ({ size: 100, type: "file", mtime: 1 }),
    readFile: () => ({ stream: new PassThrough(), done: new Promise(() => {}) }),
    unlink: async (path) => { unlinked.push(path); },
    rmdir: async () => undefined,
});

const hangingDest = (removed) => ({
    removed,
    listDir: async () => [],
    stat: async () => { throw notFound(); },
    writeFile: () => new Promise(() => {}),
    mkdirRecursive: async () => [],
    unlink: async (path) => { removed.push(path); },
    rmdir: async () => undefined,
});

test("cancel ends the run and removes the partial target", async () => {
    const removed = [];
    const transfer = new FileTransfer({ source: hangingSource([]), dest: hangingDest(removed) });

    const promise = transfer.run(["/srv/big.bin"], "/target");
    await new Promise((r) => setImmediate(r));
    transfer.cancel();

    const result = await promise;
    assert.strictEqual(result.cancelled, true);
    assert.deepStrictEqual(removed, ["/target/big.bin"]);
});

test("cancel during a move never deletes the source", async () => {
    const unlinked = [];
    const transfer = new FileTransfer({ source: hangingSource(unlinked), dest: hangingDest([]) });

    const promise = transfer.run(["/srv/big.bin"], "/target", { action: "move" });
    await new Promise((r) => setImmediate(r));
    transfer.cancel();

    const result = await promise;
    assert.strictEqual(result.cancelled, true);
    assert.deepStrictEqual(unlinked, [], "a cancelled move must leave the source intact");
});

test("cancel before the first file stops the run immediately", async () => {
    const transfer = new FileTransfer({ source: hangingSource([]), dest: hangingDest([]) });
    transfer.cancel();

    const result = await transfer.run(["/srv/big.bin"], "/target");
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.filesTransferred, 0);
});

// Cancelling while the conflict dialog is open is the likeliest moment of all.
test("cancel while waiting for a conflict decision ends the run", async () => {
    const source = hangingSource([]);
    const dest = hangingDest([]);
    dest.stat = async () => ({ size: 1, type: "file", mtime: 1, isSymlink: false });

    const transfer = new FileTransfer({ source, dest, onConflict: () => new Promise(() => {}) });
    const promise = transfer.run(["/srv/big.bin"], "/target", { onConflict: "ask" });

    await new Promise((r) => setImmediate(r));
    transfer.cancel();

    const result = await promise;
    assert.strictEqual(result.cancelled, true);
});

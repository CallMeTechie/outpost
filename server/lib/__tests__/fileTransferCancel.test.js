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

// now() never advances and setIntervalFn never actually schedules its callback, so the
// READ_STALL_TIMEOUT watchdog can never fire, real elapsed time or not. If _copyFile's cancel
// hook is not registered, nothing else can end this run: the test times out instead of passing
// slow, proving that cancel() itself — not the watchdog — is what stops the copy.
test("cancel ends the run and removes the partial target", { timeout: 2000 }, async () => {
    const removed = [];
    const transfer = new FileTransfer({
        source: hangingSource([]),
        dest: hangingDest(removed),
        now: () => 0,
        setIntervalFn: () => "fake-timer",
        clearIntervalFn: () => {},
    });

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

// walk() is the longest phase before the first byte on a folder transfer — and the likeliest
// window for a cancel on a large tree. listDir is held pending so the walk is provably still
// inside walkDir (past its first guard, before its next) when cancel() lands; the guard at the
// next recursion step must then turn that into a clean { cancelled: true } instead of a rejection.
test("cancel during a folder walk ends the run without rejecting", async () => {
    let resolveListDir;
    const pending = new Promise((resolve) => { resolveListDir = resolve; });
    const source = {
        stat: async () => ({ size: 0, type: "folder", mtime: 1 }),
        listDir: async (path) => (path === "/srv/tree" ? pending : []),
        unlink: async () => {},
        rmdir: async () => undefined,
    };

    const transfer = new FileTransfer({ source, dest: hangingDest([]) });
    const promise = transfer.run(["/srv/tree"], "/target");

    await new Promise((r) => setImmediate(r));
    transfer.cancel();
    // Resolving now, after cancel(), lets walkDir's loop reach its per-entry guard with
    // this.cancelled already true — exactly the path that used to reject instead of returning.
    resolveListDir([{ name: "leaf.txt", type: "file", size: 1, mtime: 1 }]);

    const result = await promise;
    assert.strictEqual(result.cancelled, true);
});

// _copyFile can be entered with this.cancelled already true — e.g. a cancel that lands while
// _resolveConflict is still awaiting dest.stat(). That takes the synchronous self-call branch
// (`if (this.cancelled) onCancel();`) instead of the async hook path the other tests exercise.
test("cancel that lands during conflict resolution still short-circuits the pending copy", async () => {
    let rejectStat;
    const pendingStat = new Promise((_resolve, reject) => { rejectStat = reject; });
    const removed = [];
    const source = hangingSource([]);
    const dest = hangingDest(removed);
    dest.stat = () => pendingStat;

    const transfer = new FileTransfer({ source, dest });
    const promise = transfer.run(["/srv/big.bin"], "/target");

    await new Promise((r) => setImmediate(r));
    transfer.cancel();
    // "Not found" resolves the conflict as "overwrite" without going through _ask, so _copyFile
    // is entered directly, with this.cancelled already set.
    rejectStat(notFound());

    const result = await promise;
    assert.strictEqual(result.cancelled, true);
    assert.deepStrictEqual(removed, ["/target/big.bin"]);
});

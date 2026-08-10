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

    // mkdirRecursive("/target/data/sub") creates "/target/data" as a side effect, so the parent
    // must never be requested on its own — only the leaf call should reach the destination.
    assert.deepStrictEqual(dest.created, ["/target/data/sub"]);
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

// A file that never reached writeFile has no partial to clean up — reporting one would be a
// false claim about a leftover that was never written.
test("a vanished source file is never reported as a leftover", async () => {
    const source = oneFile();
    source.readFile = () => { throw notFound(); };
    const dest = fakeDest();
    dest.unlink = async () => { throw new Error("connection gone"); };

    const result = await new FileTransfer({ source, dest }).run(["/srv/a.txt"], "/target");

    assert.deepStrictEqual(dest.removed, []);
    assert.deepStrictEqual(result.leftovers, []);
});

// The spec requires the final progress frame to reach 100% on a successful transfer, even when
// that transfer skipped a file — otherwise a completed transfer looks stuck to the user.
test("a vanished-source skip keeps bytesDone/filesDone in sync with the totals", async () => {
    const source = oneFile();
    source.readFile = () => { throw notFound(); };
    const dest = fakeDest();
    const progress = [];

    await new FileTransfer({ source, dest, onProgress: (p) => progress.push(p) }).run(["/srv/a.txt"], "/target");

    const last = progress.at(-1);
    assert.strictEqual(last.bytesDone, last.bytesTotal);
    assert.strictEqual(last.filesDone, last.filesTotal);
});

const { MAX_BUFFER, READ_STALL_TIMEOUT } = require("../fileTransfer/FileTransfer");

const fakeClock = () => {
    let current = 0;
    const ticks = [];
    return {
        now: () => current,
        setIntervalFn: (fn) => { ticks.push(fn); return ticks.length - 1; },
        clearIntervalFn: () => {},
        advance: (ms) => { current += ms; },
        tick: () => ticks.forEach((fn) => fn()),
    };
};

const stalledSource = (stream) => ({
    listDir: async () => [],
    stat: async () => ({ size: 100, type: "file", mtime: 1 }),
    readFile: () => ({ stream, done: new Promise(() => {}) }),
});

test("aborts when the buffered data exceeds MAX_BUFFER", async () => {
    const clock = fakeClock();
    const stream = new PassThrough();
    Object.defineProperty(stream, "writableLength", { get: () => MAX_BUFFER + 1 });
    const dest = fakeDest();
    dest.writeFile = () => new Promise(() => {});

    const transfer = new FileTransfer({ source: stalledSource(stream), dest, ...clock });
    const promise = transfer.run(["/srv/big.bin"], "/target");

    await new Promise((r) => setImmediate(r));
    clock.tick();

    await assert.rejects(promise, /too slow/i);
    assert.deepStrictEqual(dest.removed, ["/target/big.bin"]);
});

// The readable side must count too — otherwise an implementation that only reads
// writableLength would pass this suite.
test("the readable side counts towards MAX_BUFFER as well", async () => {
    const clock = fakeClock();
    const stream = new PassThrough();
    Object.defineProperty(stream, "readableLength", { get: () => MAX_BUFFER + 1 });
    const dest = fakeDest();
    dest.writeFile = () => new Promise(() => {});

    const transfer = new FileTransfer({ source: stalledSource(stream), dest, ...clock });
    const promise = transfer.run(["/srv/big.bin"], "/target");

    await new Promise((r) => setImmediate(r));
    clock.tick();

    await assert.rejects(promise, /too slow/i);
});

test("aborts when no data frame arrives within READ_STALL_TIMEOUT", async () => {
    const clock = fakeClock();
    const dest = fakeDest();
    dest.writeFile = () => new Promise(() => {});

    const transfer = new FileTransfer({ source: stalledSource(new PassThrough()), dest, ...clock });
    const promise = transfer.run(["/srv/stalled.bin"], "/target");

    await new Promise((r) => setImmediate(r));
    clock.advance(READ_STALL_TIMEOUT + 1);
    clock.tick();

    await assert.rejects(promise, /stalled/i);
});

// The WriteEnd flush can take up to 120 s with no data flowing — that is not a stalled read.
test("the stall watchdog is disarmed once the source stream ended", async () => {
    const clock = fakeClock();
    const stream = new PassThrough();
    const source = {
        listDir: async () => [],
        stat: async () => ({ size: 0, type: "file", mtime: 1 }),
        readFile: () => { setImmediate(() => stream.end()); return { stream, done: Promise.resolve() }; },
    };
    const dest = fakeDest();
    let finishWrite;
    dest.writeFile = (path, src) => new Promise((resolve) => {
        src.resume();
        finishWrite = () => { dest.written[path] = ""; resolve(); };
    });

    const transfer = new FileTransfer({ source, dest, ...clock });
    const promise = transfer.run(["/srv/empty.bin"], "/target");

    // Two macrotask ticks are needed here: walk/_ensureDirs/_resolveConflict each hop through a
    // microtask before _copyFile ever calls readFile(), so the mock's own setImmediate(() =>
    // stream.end()) is scheduled strictly after this test's first tick and only fires on the
    // second one. A single tick would observe sourceEnded still false and assert nothing useful.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    clock.advance(READ_STALL_TIMEOUT + 1);
    clock.tick();
    finishWrite();

    const result = await promise;
    assert.strictEqual(result.filesTransferred, 1);
    assert.deepStrictEqual(dest.removed, [], "a fully written file must not be deleted");
});

test("aborts when the source delivers far more than it announced", async () => {
    const { MAX_SIZE_OVERRUN } = require("../fileTransfer/FileTransfer");
    const clock = fakeClock();
    const stream = new PassThrough();
    const source = {
        listDir: async () => [],
        stat: async () => ({ size: 10, type: "file", mtime: 1 }),
        readFile: () => {
            setImmediate(() => stream.write(Buffer.alloc(MAX_SIZE_OVERRUN + 1024)));
            return { stream, done: new Promise(() => {}) };
        },
    };
    const dest = fakeDest();
    dest.writeFile = (path, src) => new Promise(() => { src.resume(); });

    const transfer = new FileTransfer({ source, dest, ...clock });
    await assert.rejects(transfer.run(["/srv/liar.bin"], "/target"), /more data than announced/i);
});

test("a write failure destroys the source stream", async () => {
    const stream = new PassThrough();
    const source = {
        listDir: async () => [],
        stat: async () => ({ size: 5, type: "file", mtime: 1 }),
        readFile: () => ({ stream, done: new Promise(() => {}) }),
    };
    const dest = fakeDest();
    dest.writeFile = async () => { throw new Error("disk full"); };

    await assert.rejects(() => new FileTransfer({ source, dest }).run(["/srv/a.txt"], "/target"), /disk full/);
    assert.strictEqual(stream.destroyed, true, "no reader left, the engine keeps pushing");
});

test("a healthy transfer stops its watchdog", async () => {
    const clock = fakeClock();
    let cleared = 0;
    clock.clearIntervalFn = () => { cleared += 1; };

    await new FileTransfer({ source: oneFile(), dest: fakeDest(), ...clock }).run(["/srv/a.txt"], "/target");

    assert.strictEqual(cleared, 1, "the watchdog must be stopped in a finally block");
});

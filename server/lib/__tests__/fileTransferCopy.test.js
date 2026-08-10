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
        // EngineSftpClient.writeFile sends WriteBegin and only attaches its consumer once the
        // destination server has acknowledged it. Waiting that one beat here keeps the fake from
        // being friendlier than the real adapter: a FileTransfer that hands the source stream out
        // in flowing mode loses everything the source delivers inside this window, and the test
        // sees the same truncated file the user would.
        writeFile: async (path, source) => {
            await new Promise((r) => setImmediate(r));
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

// The closest mirror of EngineSftpClient.writeFile there is: it waits for its WriteBegin ack
// before it looks at the stream at all, and it then listens for "data"/"end"/"error" instead of
// iterating. Both details matter — an "end" that already fired before this attaches is one the
// real client waits for forever, and the stall watchdog is disarmed by then.
const roundTripDest = (ticks = 3) => {
    const dest = fakeDest();
    dest.writeFile = (path, source) => new Promise((resolve, reject) => {
        const attach = async () => {
            for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
            const chunks = [];
            source.on("data", (chunk) => chunks.push(chunk));
            source.on("end", () => { dest.written[path] = Buffer.concat(chunks).toString(); resolve(); });
            source.on("error", reject);
        };
        attach();
    });
    return dest;
};

// Finding 1: counting progress must never take bytes away from the actual consumer.
test("every byte arrives even when the destination attaches its consumer late", async () => {
    const content = "x".repeat(4096);
    const source = fakeSource({}, { "/srv/big.txt": { size: content.length, type: "file", mtime: 1 } },
        { "/srv/big.txt": content });
    const dest = roundTripDest();
    const progress = [];

    const result = await new FileTransfer({ source, dest, onProgress: (p) => progress.push(p) })
        .run(["/srv/big.txt"], "/target");

    assert.strictEqual(dest.written["/target/big.txt"], content, "the destination must receive the whole file");
    assert.strictEqual(result.filesTransferred, 1);
    assert.strictEqual(progress.at(-1).bytesDone, content.length);
});

// Second symptom of the same cause: an empty file ends inside the round-trip window, so the "end"
// event has already fired by the time the destination listens for it. Without a buffering stage in
// between the write never completes — and the stall watchdog is disarmed because the source ended.
test("a source that ends during the round trip does not hang the transfer", { timeout: 2000 }, async () => {
    const source = fakeSource({}, { "/srv/empty.txt": { size: 0, type: "file", mtime: 1 } }, { "/srv/empty.txt": "" });
    const dest = roundTripDest();

    const result = await new FileTransfer({ source, dest }).run(["/srv/empty.txt"], "/target");

    assert.strictEqual(dest.written["/target/empty.txt"], "");
    assert.strictEqual(result.filesTransferred, 1);
});

// A source that keeps delivering across several ticks straddles the window: the beginning of the
// file is what gets lost, and the result still claims a successful transfer.
test("a source delivering across several ticks loses nothing at the start", async () => {
    const parts = ["one", "two", "three", "four"];
    const content = parts.join("");
    const source = {
        listDir: async () => [],
        stat: async () => ({ size: content.length, type: "file", mtime: 1 }),
        readFile: () => {
            const stream = new PassThrough();
            const push = (index) => setImmediate(() => {
                if (index === parts.length) return stream.end();
                stream.write(Buffer.from(parts[index]));
                push(index + 1);
            });
            push(0);
            return { stream, done: Promise.resolve() };
        },
    };
    const dest = roundTripDest();

    const result = await new FileTransfer({ source, dest }).run(["/srv/chunked.txt"], "/target");

    assert.strictEqual(dest.written["/target/chunked.txt"], content);
    assert.strictEqual(result.filesTransferred, 1);
});

// Finding 2: writeFile passes the destination server's own wording through, and the engine answers
// a missing path with exactly this text. Classifying by message files a failed write under "the
// source vanished" — the transfer then reports success with a skipped file although nothing at all
// was written.
test("a destination write error is never mistaken for a vanished source file", async () => {
    const dest = fakeDest();
    dest.writeFile = async () => { throw new Error("Path does not exist"); };

    const err = await new FileTransfer({ source: oneFile(), dest })
        .run(["/srv/a.txt"], "/target").then((r) => new Error(`resolved with ${JSON.stringify(r)}`), (e) => e);

    assert.match(err.message, /^Path does not exist$/, "the destination's own message has to survive");
});

// The other direction of the same decision: a source that really did vanish still has to be a skip,
// even when its message is the very text the destination uses too.
test("a source read error with the destination's wording is still a skip", async () => {
    const source = oneFile();
    source.readFile = () => { throw new Error("Path does not exist"); };

    const result = await new FileTransfer({ source, dest: fakeDest() }).run(["/srv/a.txt"], "/target");

    assert.strictEqual(result.filesSkipped, 1);
    assert.strictEqual(result.filesTransferred, 0);
    assert.strictEqual(result.cancelled, false);
});

// Finding 6: no readFile fake ever rejected its `done`. This is the read error that only shows up
// after the destination already confirmed the write — on a move the most dangerous one of all.
test("a read error arriving after the write completed fails the transfer", async () => {
    const source = oneFile();
    source.readFile = () => {
        const stream = new PassThrough();
        setImmediate(() => stream.end(Buffer.from("hello")));
        return { stream, done: Promise.reject(new Error("connection reset by peer")) };
    };

    await assert.rejects(() => new FileTransfer({ source, dest: fakeDest() }).run(["/srv/a.txt"], "/target"),
        /connection reset by peer/);
});

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

const withExistingTarget = () => fakeDest({ "/target/a.txt": { size: 99, type: "file", mtime: 7, isSymlink: false } });

test("asks about an existing target file and skips on request", async () => {
    const asked = [];
    const transfer = new FileTransfer({
        source: oneFile(), dest: withExistingTarget(),
        onConflict: async (info) => { asked.push(info); return "skip"; },
    });
    const result = await transfer.run(["/srv/a.txt"], "/target", { onConflict: "ask" });

    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].destSize, 99);
    assert.strictEqual(asked[0].srcSize, 5);
    assert.strictEqual(result.filesSkipped, 1);
    assert.strictEqual(result.filesTransferred, 0);
});

test("skipped files leave the progress totals consistent", async () => {
    const progress = [];
    const transfer = new FileTransfer({ source: oneFile(), dest: withExistingTarget(), onProgress: (p) => progress.push(p) });
    await transfer.run(["/srv/a.txt"], "/target", { onConflict: "skip" });

    assert.strictEqual(progress.at(-1).bytesDone, progress.at(-1).bytesTotal);
    assert.strictEqual(progress.at(-1).filesDone, progress.at(-1).filesTotal);
});

test("overwrite mode never asks", async () => {
    let asked = 0;
    const dest = withExistingTarget();
    const transfer = new FileTransfer({ source: oneFile(), dest, onConflict: async () => { asked += 1; return "overwrite"; } });
    const result = await transfer.run(["/srv/a.txt"], "/target", { onConflict: "overwrite" });

    assert.strictEqual(asked, 0);
    assert.strictEqual(dest.written["/target/a.txt"], "hello");
    assert.strictEqual(result.filesTransferred, 1);
});

test("skip mode never asks and never writes", async () => {
    let asked = 0;
    const transfer = new FileTransfer({ source: oneFile(), dest: withExistingTarget(), onConflict: async () => { asked += 1; return "skip"; } });
    const result = await transfer.run(["/srv/a.txt"], "/target", { onConflict: "skip" });

    assert.strictEqual(asked, 0);
    assert.strictEqual(result.filesSkipped, 1);
});

test("abort ends the transfer without an error and without deleting anything", async () => {
    const dest = withExistingTarget();
    const transfer = new FileTransfer({ source: oneFile(), dest, onConflict: async () => "abort" });
    const result = await transfer.run(["/srv/a.txt"], "/target", { onConflict: "ask" });

    assert.strictEqual(result.cancelled, true);
    assert.deepStrictEqual(dest.removed, []);
});

test("a target of a different type is always an error", async () => {
    const dest = fakeDest({ "/target/a.txt": { size: 0, type: "folder", mtime: 7, isSymlink: false } });
    const transfer = new FileTransfer({ source: oneFile(), dest, onConflict: async () => "overwrite" });

    await assert.rejects(() => transfer.run(["/srv/a.txt"], "/target", { onConflict: "overwrite" }),
        /different type/);
});

// A failing stat must never be read as "free rein".
test("a target that cannot be inspected aborts instead of overwriting", async () => {
    const dest = fakeDest();
    dest.stat = async () => { throw new Error("permission denied"); };
    const transfer = new FileTransfer({ source: oneFile(), dest });

    await assert.rejects(() => transfer.run(["/srv/a.txt"], "/target", { onConflict: "skip" }),
        /Cannot inspect target/);
});

const test = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const { FileTransfer } = require("../fileTransfer/FileTransfer");

const notFound = () => { const e = new Error("no such file"); e.code = "ENOENT"; return e; };

const makeSource = (stats, contents, { supportsChecksum = false, checksum } = {}) => {
    const unlinked = [];
    const rmdirs = [];
    return {
        unlinked, rmdirs, supportsChecksum,
        listDir: async () => [],
        stat: async (path) => {
            if (!(path in stats)) throw notFound();
            return stats[path];
        },
        readFile: (path) => {
            const stream = new PassThrough();
            setImmediate(() => stream.end(Buffer.from(contents[path] ?? "")));
            return { stream, done: Promise.resolve() };
        },
        unlink: async (path) => { unlinked.push(path); },
        rmdir: async (path, recursive) => { rmdirs.push({ path, recursive }); },
        checksum: checksum || (async () => "same"),
    };
};

const makeDest = (sizeOverride = null, { supportsChecksum = false, checksum } = {}) => {
    const written = {};
    const removed = [];
    return {
        written, removed, supportsChecksum,
        listDir: async () => [],
        stat: async (path) => {
            if (!(path in written)) throw notFound();
            return { size: sizeOverride ?? written[path].length, type: "file", mtime: 1, isSymlink: false };
        },
        // Mirrors EngineSftpClient.writeFile, which only attaches its consumer once the WriteBegin
        // round trip to the destination server has come back. A fake that reads the stream right
        // away would never notice a source stream handed out in flowing mode.
        writeFile: async (path, source) => {
            await new Promise((r) => setImmediate(r));
            const chunks = [];
            for await (const chunk of source) chunks.push(chunk);
            written[path] = Buffer.concat(chunks).toString();
        },
        mkdirRecursive: async () => [],
        unlink: async (path) => { removed.push(path); },
        rmdir: async () => undefined,
        checksum: checksum || (async () => "same"),
    };
};

const oneFileSource = (opts) =>
    makeSource({ "/srv/a.txt": { size: 5, type: "file", mtime: 1 } }, { "/srv/a.txt": "hello" }, opts);

test("move deletes the source only after the size was verified", async () => {
    const source = oneFileSource();
    const result = await new FileTransfer({ source, dest: makeDest() })
        .run(["/srv/a.txt"], "/target", { action: "move" });

    assert.strictEqual(result.filesTransferred, 1);
    assert.deepStrictEqual(source.unlinked, ["/srv/a.txt"]);
});

test("a size mismatch leaves the source untouched", async () => {
    const source = oneFileSource();
    await assert.rejects(
        () => new FileTransfer({ source, dest: makeDest(3) }).run(["/srv/a.txt"], "/target", { action: "move" }),
        /Verification failed/);
    assert.deepStrictEqual(source.unlinked, []);
});

test("copy never deletes the source", async () => {
    const source = oneFileSource();
    await new FileTransfer({ source, dest: makeDest() }).run(["/srv/a.txt"], "/target", { action: "copy" });
    assert.deepStrictEqual(source.unlinked, []);
});

test("checksums are compared when both sides support them", async () => {
    const calls = [];
    const source = oneFileSource({ supportsChecksum: true, checksum: async () => { calls.push("src"); return "abc"; } });
    const dest = makeDest(null, { supportsChecksum: true, checksum: async () => { calls.push("dst"); return "abc"; } });

    await new FileTransfer({ source, dest }).run(["/srv/a.txt"], "/target", { action: "move" });

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(source.unlinked, ["/srv/a.txt"]);
});

test("a checksum mismatch leaves the source untouched", async () => {
    const source = oneFileSource({ supportsChecksum: true, checksum: async () => "abc" });
    const dest = makeDest(null, { supportsChecksum: true, checksum: async () => "different" });

    await assert.rejects(() => new FileTransfer({ source, dest }).run(["/srv/a.txt"], "/target", { action: "move" }),
        /Verification failed/);
    assert.deepStrictEqual(source.unlinked, []);
});

test("checksums are skipped when one side has no shell", async () => {
    let called = 0;
    const source = oneFileSource({ supportsChecksum: true, checksum: async () => { called += 1; return "abc"; } });
    const dest = makeDest(null, { supportsChecksum: false });

    await new FileTransfer({ source, dest }).run(["/srv/a.txt"], "/target", { action: "move" });

    assert.strictEqual(called, 0, "checksums need a shell on both sides");
    assert.deepStrictEqual(source.unlinked, ["/srv/a.txt"]);
});

const folderSource = (entries) => {
    const source = makeSource({ "/srv/data": { size: 0, type: "folder", mtime: 1 } }, {});
    source.listDir = async () => entries;
    source.readFile = () => {
        const stream = new PassThrough();
        setImmediate(() => stream.end(Buffer.from("hi")));
        return { stream, done: Promise.resolve() };
    };
    return source;
};

// rmdir(path, true) would delete skipped entries that were never transferred.
test("source folders are removed bottom-up and never recursively", async () => {
    const source = folderSource([{ name: "x.txt", type: "file", size: 2, mtime: 1, isSymlink: false, mode: 33188 }]);

    await new FileTransfer({ source, dest: makeDest() }).run(["/srv/data"], "/target", { action: "move" });

    assert.deepStrictEqual(source.rmdirs, [{ path: "/srv/data", recursive: false }]);
});

test("a skipped symlink leaves its source folder standing", async () => {
    const source = folderSource([
        { name: "link", type: "file", size: 1, mtime: 1, isSymlink: true, mode: 41471 },
        { name: "x.txt", type: "file", size: 2, mtime: 1, isSymlink: false, mode: 33188 },
    ]);
    source.rmdir = async () => { throw new Error("directory not empty"); };

    const result = await new FileTransfer({ source, dest: makeDest() })
        .run(["/srv/data"], "/target", { action: "move" });

    assert.deepStrictEqual(source.unlinked, ["/srv/data/x.txt"], "only verified files are deleted");
    assert.ok(result.sourceLeftovers.includes("/srv/data"), "a non-empty source folder is reported, not force-deleted");
    assert.deepStrictEqual(result.leftovers, [], "a source folder is not an undeletable partial file at the destination");
});

test("a vanished source file stops the move from deleting anything", async () => {
    const source = oneFileSource();
    source.readFile = () => { throw notFound(); };

    await assert.rejects(() => new FileTransfer({ source, dest: makeDest() })
        .run(["/srv/a.txt"], "/target", { action: "move" }), /incomplete/i);
    assert.deepStrictEqual(source.unlinked, []);
});

// The same gap as on the copy path: a source that vanishes MID-READ fails asynchronously, its error
// is piped into the destination stream, and writeFile rejects with it. Read as a destination failure
// the move aborts with the destination's wording instead of the "verification incomplete" refusal —
// the message that tells the user why nothing was deleted.
test("a source stream failing after the destination attached blocks the move", async () => {
    const source = oneFileSource();
    source.readFile = () => {
        const stream = new PassThrough();
        // Three ticks put the failure behind makeDest's WriteBegin-style attach, so the error
        // travels through the destination stream instead of into an empty room.
        const step = (left) => setImmediate(() => (left === 0
            ? stream.destroy(new Error("Path does not exist"))
            : step(left - 1)));
        step(3);
        return { stream, done: new Promise(() => {}) };
    };

    await assert.rejects(() => new FileTransfer({ source, dest: makeDest() })
        .run(["/srv/a.txt"], "/target", { action: "move" }), /incomplete/i);
    assert.deepStrictEqual(source.unlinked, [], "nothing may be deleted after a source file vanished");
});

// Finding 2 on the move path: a failed write must not be filed as "the source vanished". It used to
// end in the sourceIncomplete branch, so the run did fail — but with a message blaming the source
// for something the destination did.
test("a destination write error fails the move with the destination's own message", async () => {
    const source = oneFileSource();
    const dest = makeDest();
    dest.writeFile = async () => { throw new Error("Path does not exist"); };

    const err = await new FileTransfer({ source, dest })
        .run(["/srv/a.txt"], "/target", { action: "move" }).then(() => null, (e) => e);

    assert.match(err.message, /^Path does not exist$/);
    assert.deepStrictEqual(source.unlinked, []);
});

// Finding 6: the read error that only arrives once the destination confirmed the write is the most
// dangerous one on a move — nothing may be deleted on the source after it.
test("a read error arriving after the write never deletes the source", async () => {
    const source = oneFileSource();
    source.readFile = () => {
        const stream = new PassThrough();
        setImmediate(() => stream.end(Buffer.from("hello")));
        return { stream, done: Promise.reject(new Error("connection reset by peer")) };
    };

    await assert.rejects(() => new FileTransfer({ source, dest: makeDest() })
        .run(["/srv/a.txt"], "/target", { action: "move" }), /connection reset by peer/);
    assert.deepStrictEqual(source.unlinked, []);
});

test("a failing source delete reports that the data is safe", async () => {
    const source = oneFileSource();
    source.unlink = async () => { throw new Error("permission denied"); };

    const err = await new FileTransfer({ source, dest: makeDest() })
        .run(["/srv/a.txt"], "/target", { action: "move" }).then(() => null, (e) => e);

    assert.match(err.message, /source was not fully removed/i);
    assert.strictEqual(err.dataIsSafe, true);
});

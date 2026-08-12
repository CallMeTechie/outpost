const test = require("node:test");
const assert = require("node:assert");
const { createOneDriveAdapter, MAX_PAGES, PAGE_SIZE } = require("../microsoft/oneDriveAdapter");
const { READ_STALL_TIMEOUT } = require("../fileTransfer/FileTransfer");

const folder = (name, extra = {}) => ({ name, folder: {}, size: 0, lastModifiedDateTime: "2026-08-12T18:00:00Z", ...extra });
const file = (name, size = 10) => ({ name, file: {}, size, lastModifiedDateTime: "2026-08-12T18:00:00Z" });

const fakeGraph = (handler) => {
    const calls = [];
    return { calls, request: async (connectionId, options) => { calls.push(options); return handler(options, calls.length); } };
};

const adapterOn = (handler) => {
    const graph = fakeGraph(handler);
    return { graph, adapter: createOneDriveAdapter({ graph, connectionId: 1 }) };
};

test("the adapter reports no checksum support and names no transport", () => {
    const { adapter } = adapterOn(() => ({ body: {} }));

    assert.strictEqual(adapter.supportsChecksum, false);
    assert.strictEqual(adapter.transport, undefined,
        "a transport would make FileTransfer refuse two OneDrive sides against each other");
});

test("the root folder is addressed without the path syntax", async () => {
    const { graph, adapter } = adapterOn(() => ({ body: { value: [] } }));

    await adapter.listDir("/");

    assert.match(graph.calls[0].url, /^\/root\/children\?/);
});

test("a nested path is addressed with it", async () => {
    const { graph, adapter } = adapterOn(() => ({ body: { value: [] } }));

    await adapter.listDir("/Dokumente/Rechnungen");

    assert.match(graph.calls[0].url, /^\/root:\/Dokumente\/Rechnungen:\/children\?/);
});

test("a name with spaces and umlauts is encoded, the separators are not", async () => {
    const { graph, adapter } = adapterOn(() => ({ body: { value: [] } }));

    await adapter.listDir("/Meine Ablage/Größe");

    assert.match(graph.calls[0].url, /^\/root:\/Meine%20Ablage\/Gr%C3%B6%C3%9Fe:\/children\?/);
});

// The path arrives from a client. Traversal must not be something the adapter forwards politely.
test("a traversal segment is refused rather than sent", async () => {
    const { graph, adapter } = adapterOn(() => ({ body: { value: [] } }));

    for (const path of ["/a/../b", "/../etc", "/a/./b", ".."]) {
        await assert.rejects(adapter.listDir(path), /invalid/i, `accepted ${path}`);
    }
    assert.strictEqual(graph.calls.length, 0, "nothing may reach Graph");
});

test("a segment that would break path addressing is refused", async () => {
    const { adapter } = adapterOn(() => ({ body: { value: [] } }));

    for (const path of ["/a:b", "/a\\b", "/a\x01b", "/a\x7fb"]) {
        await assert.rejects(adapter.listDir(path), /invalid/i, `accepted ${path}`);
    }
});

test("a path that is not a string is refused rather than coerced into the root", async () => {
    const { graph, adapter } = adapterOn(() => ({ body: { value: [] } }));

    for (const path of [null, undefined, 42, {}, ["a"]]) {
        await assert.rejects(adapter.listDir(path), /invalid/i, `accepted ${JSON.stringify(path)}`);
    }
    assert.strictEqual(graph.calls.length, 0, "nothing may reach Graph");
});

test("listDir maps Graph's shape onto the one the transfer expects", async () => {
    const { adapter } = adapterOn(() => ({ body: { value: [folder("Bilder"), file("brief.txt", 42)] } }));

    const entries = await adapter.listDir("/");

    assert.deepStrictEqual(entries[0], {
        name: "Bilder", type: "folder", size: 0, mtime: 1786557600, isSymlink: false,
    });
    assert.deepStrictEqual(entries[1], {
        name: "brief.txt", type: "file", size: 42, mtime: 1786557600, isSymlink: false,
    });
});

// The SFTP side reports epoch seconds. Handing an ISO string upwards would put a string where
// every other adapter puts a number.
test("the modification time arrives as epoch seconds, and a broken one as zero", async () => {
    const { adapter } = adapterOn(() => ({ body: { value: [file("a"), { name: "b", file: {}, size: 1, lastModifiedDateTime: "not a date" }] } }));

    const entries = await adapter.listDir("/");

    assert.strictEqual(typeof entries[0].mtime, "number");
    assert.strictEqual(entries[1].mtime, 0);
});

test("listDir follows the pages Graph hands out", async () => {
    const { graph, adapter } = adapterOn((options, n) => (n === 1
        ? { body: { value: [file("one")], "@odata.nextLink": "https://graph.example/page2" } }
        : { body: { value: [file("two")] } }));

    const entries = await adapter.listDir("/");

    assert.deepStrictEqual(entries.map((e) => e.name), ["one", "two"]);
    assert.strictEqual(graph.calls[1].url, "https://graph.example/page2");
});

// Truncating would be the dangerous answer: a folder walk that never saw the rest would move the
// files it did see and then delete the source folder.
test("a folder beyond the page ceiling fails instead of returning a part of itself", async () => {
    const { adapter } = adapterOn(() => ({ body: { value: [file("x")], "@odata.nextLink": "https://graph.example/next" } }));

    await assert.rejects(adapter.listDir("/"), new RegExp(String(MAX_PAGES * PAGE_SIZE)));
});

test("stat reports the four fields the transfer reads", async () => {
    const { adapter } = adapterOn(() => ({ body: file("brief.txt", 4096) }));

    assert.deepStrictEqual(await adapter.stat("/brief.txt"), {
        size: 4096, type: "file", mtime: 1786557600, isSymlink: false,
    });
});

test("stat calls a folder a folder", async () => {
    const { adapter } = adapterOn(() => ({ body: folder("Bilder") }));

    assert.strictEqual((await adapter.stat("/Bilder")).type, "folder");
});

test("readFile delivers the bytes and settles done when the stream ends", async () => {
    const { adapter } = adapterOn(() => ({
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([104, 97, 108]));
                controller.enqueue(new Uint8Array([108, 111]));
                controller.close();
            },
        }),
    }));

    const { stream, done } = adapter.readFile("/hallo.txt");
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    await done;

    assert.strictEqual(Buffer.concat(chunks).toString(), "hallo");
});

test("readFile asks for the content, not for the item", async () => {
    const { graph, adapter } = adapterOn(() => ({ body: new ReadableStream({ start: (c) => c.close() }) }));

    adapter.readFile("/a/b.txt");
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(graph.calls[0].url, "/root:/a/b.txt:/content");
    assert.strictEqual(graph.calls[0].parse, "raw");
});

// The content request is over before a byte flows, which is exactly what keeps FileTransfer's
// pipeline EMPTY for the whole backoff — and an empty pipeline gets READ_STALL_TIMEOUT, not the ten
// times longer window a full one gets. A backoff longer than that window is aborted from above as
// "Read stalled" however correctly the client was waiting, so the read side names a tighter budget.
test("readFile gives the content request a wait budget under the read-stall window", async () => {
    const { graph, adapter } = adapterOn(() => ({ body: new ReadableStream({ start: (c) => c.close() }) }));

    adapter.readFile("/a/b.txt");
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(Number.isInteger(graph.calls[0].maxTotalWaitMs), "the read must cap its own waiting at all");
    assert.ok(graph.calls[0].maxTotalWaitMs < READ_STALL_TIMEOUT,
        `${graph.calls[0].maxTotalWaitMs} does not fit inside the ${READ_STALL_TIMEOUT} ms read-stall window`);
});

test("an empty file ends the stream instead of throwing", async () => {
    const { adapter } = adapterOn(() => ({ body: null }));

    const { stream, done } = adapter.readFile("/leer.txt");
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    await done;

    assert.strictEqual(Buffer.concat(chunks).length, 0);
});

// FileTransfer has no AbortSignal — it cancels by destroying the stream. Without this the download
// would run to its end at Microsoft while nobody was listening any more.
test("destroying the read stream reaches the running request", async () => {
    let captured = null;
    const { adapter } = adapterOn((options) => {
        captured = options.signal;
        return new Promise(() => {});
    });

    const { stream, done } = adapter.readFile("/gross.bin");
    done.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));

    stream.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(captured, "the request must be given a signal at all");
    assert.ok(captured.aborted, "and that signal must be aborted when the reader goes away");
});

// Without the readableEnded guard the close handler would abort after a perfectly normal end. That
// mutation is invisible through `done` — it is already resolved by then, and a late reject is a
// silent no-op — so the signal itself is what has to be asserted.
test("a stream that ended on its own is not treated as a cancel", async () => {
    let captured = null;
    const { adapter } = adapterOn((options) => {
        captured = options.signal;
        return {
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array([1, 2, 3]));
                    controller.close();
                },
            }),
        };
    });

    const { stream, done } = adapter.readFile("/klein.txt");
    for await (const chunk of stream) void chunk;
    await done;
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(captured.aborted, false, "a read that finished must not abort its own request");
});

test("a cancelled read settles done rather than leaving it pending", async () => {
    const { adapter } = adapterOn(() => new Promise(() => {}));

    const { stream, done } = adapter.readFile("/gross.bin");
    await new Promise((resolve) => setImmediate(resolve));
    stream.destroy();

    await assert.rejects(done, /cancel/i);
});

// pipe() forwards no error from its source. A body that drops mid-file therefore emits "error" on
// a Readable nobody listens to, and an uncaught exception is not a failed transfer here — index.js
// hands it to errorHandling.js, which calls process.exit(1) and takes every SSH session on the box
// with it. Removing the listener in the adapter makes both of these fail rather than pass.
test("a body that drops mid-file rejects done instead of escaping as an uncaught exception", async () => {
    const { adapter } = adapterOn(() => ({
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([104, 97]));
                controller.enqueue(new Uint8Array([108, 108, 111]));
                controller.error(new Error("network dropped"));
            },
        }),
    }));

    const { stream, done } = adapter.readFile("/gross.bin");
    stream.resume();

    await assert.rejects(done, /network dropped/);
});

// The same shape one step later: the reader is already gone when the body gives up — which is what
// this branch's own cancel path produces, because destroying the stream aborts the fetch and an
// aborted body errors. There is nothing left to report it to, so it must simply not escape.
test("a body that drops after the read was cancelled settles rather than escaping", async () => {
    let body = null;
    const { adapter } = adapterOn(() => ({
        body: new ReadableStream({
            start(controller) {
                body = controller;
                controller.enqueue(new Uint8Array([104, 97, 108]));
            },
        }),
    }));

    const { stream, done } = adapter.readFile("/gross.bin");
    await new Promise((resolve) => setImmediate(resolve));

    stream.destroy();
    body.error(new Error("network dropped"));

    await assert.rejects(done, /cancel/i);
    // The body's error lands after the destroy. Nothing may come out of the process from there.
    await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a failed read rejects done rather than hanging", async () => {
    const { adapter } = adapterOn(() => { throw new Error("Microsoft said no"); });

    const { stream, done } = adapter.readFile("/gone.txt");
    stream.on("error", () => {});

    await assert.rejects(done, /Microsoft said no/);
});

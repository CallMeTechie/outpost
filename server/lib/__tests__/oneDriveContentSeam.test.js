const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");
const { createOneDriveAdapter, pickThumbnailStep } = require("../microsoft/oneDriveAdapter");
const { createGraphClient } = require("../microsoft/graphClient");

const adapterOn = (handler) => {
    const calls = [];
    const graph = { calls, request: async (connectionId, options) => { calls.push(options); return handler(options, calls.length); } };
    return { graph, calls, adapter: createOneDriveAdapter({ graph, connectionId: 1 }) };
};

const streamOf = (buffer) => Readable.from([buffer]);

// --- cTag: stat and listDir both carry it -----------------------------------------------------

test("stat's SELECT asks Graph for cTag, and the result carries it", async () => {
    const { graph, adapter } = adapterOn(() => ({
        body: { name: "brief.txt", file: {}, size: 10, lastModifiedDateTime: "2026-08-12T18:00:00Z", cTag: "c:1234" },
    }));

    const stats = await adapter.stat("/brief.txt");

    assert.match(graph.calls[0].url, /cTag/, "the $select list must ask Graph for it");
    assert.strictEqual(stats.cTag, "c:1234");
});

test("listDir carries each entry's cTag too", async () => {
    const { adapter } = adapterOn(() => ({
        body: { value: [{ name: "a.txt", file: {}, size: 1, lastModifiedDateTime: "2026-08-12T18:00:00Z", cTag: "c:a" }] },
    }));

    const entries = await adapter.listDir("/");

    assert.strictEqual(entries[0].cTag, "c:a");
});

// --- writeFile ifMatch: both directions pinned -------------------------------------------------

test("writeFile with an ifMatch option sends it as If-Match", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));

    await adapter.writeFile("/a.txt", streamOf(Buffer.alloc(4, 1)), { size: 4, ifMatch: "c:old" });

    assert.deepStrictEqual(calls[0].headers, { "Content-Type": "application/octet-stream", "If-Match": "c:old" });
});

test("writeFile without an ifMatch option sends no condition at all", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));

    await adapter.writeFile("/a.txt", streamOf(Buffer.alloc(4, 1)), { size: 4 });

    assert.deepStrictEqual(calls[0].headers, { "Content-Type": "application/octet-stream" },
        "omitting ifMatch must omit the header, not send it empty or unconditionally");
});

// A stale tag must reach the caller with Microsoft's own wording, not a generic failure — routed
// through the REAL graphClient (not the fake above) so this proves readGraphMessage's output, not
// a string this test made up itself.
test("writeFile against a 412 throws with the message readGraphMessage produced", async () => {
    const graph = createGraphClient({
        getAccessToken: async () => "tok",
        forgetToken: () => {},
        fetchImpl: async () => ({
            ok: false,
            status: 412,
            headers: new Map(),
            json: async () => ({ error: { message: "The resource has changed since the eTag was retrieved." } }),
        }),
        sleep: async () => {},
    });
    const adapter = createOneDriveAdapter({ graph, connectionId: 1 });

    await assert.rejects(
        adapter.writeFile("/a.txt", Buffer.alloc(4, 1), { ifMatch: "c:old" }),
        /resource has changed since the eTag was retrieved/,
    );
});

// --- thumbnail: size -> step, fetch the URL, return bytes --------------------------------------

const thumbnailBytes = () => new TextEncoder().encode("jpeg-bytes").buffer;

const thumbnailGraph = (metaWidth) => adapterOn((options, n) => (n === 1
    ? { body: { width: metaWidth, height: metaWidth, url: "https://graph.microsoft.com/thumb1" } }
    : { headers: { get: (name) => (name === "content-type" ? "image/jpeg" : null) }, arrayBuffer: async () => thumbnailBytes() }));

test("thumbnail(path, 100) asks for the smallest step at least 100 pixels wide", async () => {
    const { graph, adapter } = thumbnailGraph(176);

    await adapter.thumbnail("/photo.jpg", 100);

    assert.match(graph.calls[0].url, /\/thumbnails\/0\/medium$/);
});

test("thumbnail(path, 300) asks for a larger step than 100 does", async () => {
    const { graph, adapter } = thumbnailGraph(800);

    await adapter.thumbnail("/photo.jpg", 300);

    assert.match(graph.calls[0].url, /\/thumbnails\/0\/large$/);
});

test("thumbnail fetches the URL Graph returned and hands back bytes, not the URL", async () => {
    const { graph, adapter } = thumbnailGraph(176);

    const result = await adapter.thumbnail("/photo.jpg", 100);

    assert.ok(Buffer.isBuffer(result.data), "data must be bytes the route can res.end()");
    assert.strictEqual(result.data.toString(), "jpeg-bytes");
    assert.strictEqual(result.contentType, "image/jpeg");
    // The second request is what proves the pre-authenticated URL never leaves the server: no
    // bearer token attached (anonymous) and no JSON parsing of what is image data (raw).
    assert.strictEqual(graph.calls[1].url, "https://graph.microsoft.com/thumb1");
    assert.strictEqual(graph.calls[1].anonymous, true);
    assert.strictEqual(graph.calls[1].parse, "raw");
});

test("a file with no thumbnail throws rather than returning an empty image", async () => {
    const { adapter } = adapterOn(() => ({ body: {} }));

    await assert.rejects(adapter.thumbnail("/document.pdf", 100), /thumbnail/i);
});

// Pure function, checked at its boundaries and independent of the route's own 50-300 clamp: exactly
// on a step, just below it, just above it, and above the largest step Graph offers at all.
test("pickThumbnailStep picks the smallest step at least as wide as asked, never a smaller one", () => {
    assert.strictEqual(pickThumbnailStep(96), "small", "exactly on the small step");
    assert.strictEqual(pickThumbnailStep(95), "small", "just below the small step");
    assert.strictEqual(pickThumbnailStep(97), "medium", "just above the small step");
    assert.strictEqual(pickThumbnailStep(176), "medium", "exactly on the medium step");
    assert.strictEqual(pickThumbnailStep(177), "large", "just above the medium step");
    assert.strictEqual(pickThumbnailStep(800), "large", "exactly on the large step");
    assert.strictEqual(pickThumbnailStep(5000), "large", "above the largest step, no bigger answer exists");
});

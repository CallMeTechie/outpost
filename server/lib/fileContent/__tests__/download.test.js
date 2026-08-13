const test = require("node:test");
const assert = require("node:assert");
const { getExt, getFileName, sanitizeFileName, clampThumbSize, contentHeaders, sendFile, MIME_TYPES, THUMB_EXTS }
    = require("../download");

test("the extension is taken from the last dot, lowercased", () => {
    assert.strictEqual(getExt("/a/B.PNG"), "png");
    assert.strictEqual(getExt("/a/archive.tar.gz"), "gz");
});

test("the file name is the last segment", () => {
    assert.strictEqual(getFileName("/a/b/c.txt"), "c.txt");
    assert.strictEqual(getFileName("/top.txt"), "top.txt");
});

// Without sanitizing, a quote from the file name would land in the header and end the string
// right there.
test("a name is stripped to word characters, spaces, dots and dashes", () => {
    assert.strictEqual(sanitizeFileName('re"port.txt'), "re_port.txt");
    assert.strictEqual(sanitizeFileName("Bericht 2026-01.pdf"), "Bericht 2026-01.pdf");
    assert.strictEqual(sanitizeFileName("a".repeat(300)).length, 255);
});

test("the thumbnail size is clamped to 50-300 and defaults to 100", () => {
    assert.strictEqual(clampThumbSize(undefined), 100);
    assert.strictEqual(clampThumbSize("nonsense"), 100);
    assert.strictEqual(clampThumbSize("10"), 50);
    assert.strictEqual(clampThumbSize("9000"), 300);
    assert.strictEqual(clampThumbSize("120"), 120);
});

test("a download is an attachment, a preview is inline, and both carry the encoded name", () => {
    const download = contentHeaders({ fileName: "Bericht Ü.pdf", size: 12, ext: "pdf", preview: false });
    assert.match(download["Content-Disposition"], /^attachment; /);
    assert.match(download["Content-Disposition"], /filename\*=UTF-8''Bericht%20%C3%9C\.pdf$/);
    assert.strictEqual(download["Content-Length"], 12);
    assert.strictEqual(download["Content-Type"], MIME_TYPES.pdf);

    const preview = contentHeaders({ fileName: "x.pdf", size: 1, ext: "pdf", preview: true });
    assert.match(preview["Content-Disposition"], /^inline; /);
});

// Without this branch, an unknown extension would reach the browser with a guessed type.
test("an unknown extension gets no Content-Type at all", () => {
    const headers = contentHeaders({ fileName: "x.zzz", size: 1, ext: "zzz", preview: false });
    assert.strictEqual("Content-Type" in headers, false);
});

test("the thumbnail extensions are exactly the image formats the engine can resize", () => {
    assert.deepStrictEqual([...THUMB_EXTS].sort(), ["bmp", "gif", "jpeg", "jpg", "png", "webp"]);
});

// A fake response: enough of res.header/status/end/on("close") to drive sendFile without a real
// socket. headersSent flips only once end() runs, matching how Express only flushes headers once
// bytes actually go out.
const fakeRes = () => {
    const listeners = {};
    return {
        headers: {},
        headersSent: false,
        ended: false,
        statusCalls: 0,
        header(name, value) { this.headers[name] = value; },
        status(code) { this.statusCalls++; this.statusCode = code; return this; },
        end() { this.ended = true; this.headersSent = true; },
        on(event, cb) { listeners[event] = cb; },
        close() { listeners.close?.(); },
    };
};

// A fake stream: pipe() is a no-op because these tests drive error/destroy directly instead of
// pushing bytes through a real pipeline.
const fakeStream = () => {
    const listeners = {};
    return {
        destroyed: false,
        on(event, cb) { listeners[event] = cb; return this; },
        pipe() { return this; },
        destroy() { this.destroyed = true; },
        fail(err) { listeners.error?.(err); },
    };
};

const fakeAdapter = (stream, size = 3) => ({
    stat: async () => ({ size }),
    readFile: () => ({ stream }),
});

test("sendFile applies the content headers to the response in order", async () => {
    const res = fakeRes();
    await sendFile(fakeAdapter(fakeStream(), 12), res, "/a/report.pdf", { preview: false });
    assert.deepStrictEqual(Object.keys(res.headers), ["Content-Disposition", "Content-Length", "Content-Type"]);
    assert.strictEqual(res.headers["Content-Length"], 12);
    assert.strictEqual(res.headers["Content-Type"], MIME_TYPES.pdf);
});

// Task 2 found that a destroyed stream left in archiver's queue hangs a ZIP forever. The
// single-file path has its own version of that risk: without this guard, a stream error leaves
// the response open instead of ending it.
test("a stream error before any bytes flowed ends the response instead of leaving it open", async () => {
    const stream = fakeStream();
    const res = fakeRes();
    await sendFile(fakeAdapter(stream), res, "/a/b.txt", { preview: false });
    stream.fail(new Error("disk error"));
    assert.strictEqual(res.ended, true);
});

// Without this guard, a client that disconnects mid-download leaves the read stream running
// against a socket nobody is reading from anymore.
test("the response closing destroys the stream instead of leaking it", async () => {
    const stream = fakeStream();
    const res = fakeRes();
    await sendFile(fakeAdapter(stream), res, "/a/b.txt", { preview: false });
    res.close();
    assert.strictEqual(stream.destroyed, true);
});

// Once bytes are already flowing, headers are already out on the wire; the error handler must not
// try to set a status code on a response that can no longer accept one.
test("a stream error after headers were already sent does not attempt to set a status", async () => {
    const stream = fakeStream();
    const res = fakeRes();
    await sendFile(fakeAdapter(stream), res, "/a/b.txt", { preview: false });
    res.end();
    stream.fail(new Error("disk error"));
    assert.strictEqual(res.statusCalls, 0);
});

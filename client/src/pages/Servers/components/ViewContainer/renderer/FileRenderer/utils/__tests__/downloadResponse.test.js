import test from "node:test";
import assert from "node:assert";
import { readErrorMessage, fileNameFromDisposition } from "../downloadResponse.js";

// Fake fetch Response — only the two members either helper reads.
const fakeResponse = ({ json, headers = {} } = {}) => ({
    json: json ?? (async () => { throw new Error("not JSON"); }),
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

test("readErrorMessage reads the server's own error field", async () => {
    const response = fakeResponse({ json: async () => ({ error: "This item does not exist in OneDrive" }) });
    assert.strictEqual(await readErrorMessage(response, "fallback"), "This item does not exist in OneDrive");
});

test("readErrorMessage falls back when the body has no error field", async () => {
    const response = fakeResponse({ json: async () => ({}) });
    assert.strictEqual(await readErrorMessage(response, "fallback"), "fallback");
});

// The actual bug this guards: a body that is not JSON at all — an empty response, an upstream
// proxy's HTML error page — must not throw out of readErrorMessage itself and hide the real
// failure behind an unrelated parse error.
test("readErrorMessage falls back when the body is not JSON", async () => {
    const response = fakeResponse();
    assert.strictEqual(await readErrorMessage(response, "fallback"), "fallback");
});

test("fileNameFromDisposition reads a quoted filename", () => {
    const response = fakeResponse({ headers: { "content-disposition": 'attachment; filename="report.txt"' } });
    assert.strictEqual(fileNameFromDisposition(response, "fallback.txt"), "report.txt");
});

test("fileNameFromDisposition reads an unquoted filename", () => {
    const response = fakeResponse({ headers: { "content-disposition": "attachment; filename=report.txt" } });
    assert.strictEqual(fileNameFromDisposition(response, "fallback.txt"), "report.txt");
});

test("fileNameFromDisposition falls back when the header is missing", () => {
    const response = fakeResponse();
    assert.strictEqual(fileNameFromDisposition(response, "fallback.txt"), "fallback.txt");
});

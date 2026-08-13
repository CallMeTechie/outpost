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

// The actual regression: download.js sends both forms together (contentHeaders), and the sanitized
// filename="..." is ASCII-only — an umlaut in the real name would come back as an underscore if
// this picked the quoted form instead of decoding filename*.
test("fileNameFromDisposition prefers the RFC 5987 filename* over the sanitized quoted form", () => {
    const response = fakeResponse({
        headers: {
            "content-disposition": "attachment; filename=\"Pr_sentation _final_.pdf\"; "
                + "filename*=UTF-8''Pr%C3%A4sentation%20%28final%29.pdf",
        },
    });
    assert.strictEqual(fileNameFromDisposition(response, "fallback.pdf"), "Präsentation (final).pdf");
});

// RFC 5987 allows a language tag between the two single quotes; the server never sends one, but
// the parser must not require the charset segment to be immediately followed by ''.
test("fileNameFromDisposition decodes a filename* with a language tag", () => {
    const response = fakeResponse({
        headers: { "content-disposition": "attachment; filename*=UTF-8'de'Bericht%20%C3%9C.pdf" },
    });
    assert.strictEqual(fileNameFromDisposition(response, "fallback.pdf"), "Bericht Ü.pdf");
});

// decodeURIComponent throws on a truncated percent-escape ("%" not followed by two hex digits).
// That must not propagate out of a helper called mid-download — and the name it recovers should
// still be usable rather than silently dropped in favor of a worse fallback.
test("fileNameFromDisposition falls back to the raw value when filename* cannot be decoded", () => {
    const response = fakeResponse({
        headers: { "content-disposition": "attachment; filename*=UTF-8''broken%2" },
    });
    assert.strictEqual(fileNameFromDisposition(response, "fallback.pdf"), "broken%2");
});

// A charset other than UTF-8 (e.g. ISO-8859-1) cannot be run through decodeURIComponent, which
// only ever decodes UTF-8 byte sequences — doing so anyway would silently corrupt the name instead
// of just falling back to the sanitized quoted form.
test("fileNameFromDisposition ignores a filename* with a non-UTF-8 charset", () => {
    const response = fakeResponse({
        headers: {
            "content-disposition": "attachment; filename=\"cafe.pdf\"; filename*=ISO-8859-1''caf%E9.pdf",
        },
    });
    assert.strictEqual(fileNameFromDisposition(response, "fallback.pdf"), "cafe.pdf");
});

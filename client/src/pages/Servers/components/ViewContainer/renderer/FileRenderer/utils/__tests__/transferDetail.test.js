import test from "node:test";
import assert from "node:assert";
import { transferDetailText } from "../transferDetail.js";

// Mirrors the interpolation of the real translation strings closely enough to check composition
// (which key, which params) without pulling in react-i18next or the locale files.
const templates = {
    "servers.fileManager.transfers.connectionLost": "Connection lost",
    "servers.fileManager.transfers.failed": "Failed: {{message}}",
    "servers.fileManager.transfers.cancelled": "Cancelled",
    "servers.fileManager.transfers.done": "{{count}} transferred",
    "servers.fileManager.transfers.cancelling": "Cancelling…",
    "servers.fileManager.transfers.progress": "{{filesDone}} of {{filesTotal}}",
    "servers.fileManager.transfers.progressPercent": "{{label}} · {{percent}} %",
};
// i18next HTML-escapes interpolated values by default, which is what turned a path like
// "/root/xfer-ziel" into "&#x2F;root&#x2F;xfer-ziel" on screen - redundant with React's own
// escaping, and wrong for text that is not markup. Mirroring that default here, and only
// skipping it when a call opts out with interpolation.escapeValue: false exactly like the
// real library, lets a test catch a call site that forgets the opt-out.
const escapeForHtml = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\//g, "&#x2F;");

const t = (key, params = {}) => {
    const { interpolation, ...values } = params;
    const escape = interpolation?.escapeValue === false ? String : escapeForHtml;
    return templates[key].replace(/{{(\w+)}}/g, (_, name) => escape(values[name]));
};

test("a running transfer with a filename shows the name and its percent", () => {
    assert.strictEqual(
        transferDetailText({ status: "running", file: "gross.bin", bytesDone: 43, bytesTotal: 100 }, t),
        "gross.bin · 43 %",
    );
});

test("a running transfer without a filename yet falls back to the file count, still with a percent", () => {
    assert.strictEqual(
        transferDetailText({ status: "running", filesDone: 3, filesTotal: 12 }, t),
        "3 of 12 · 25 %",
    );
});

test("a transfer that has reported nothing yet reads as zero percent, not NaN or blank", () => {
    assert.strictEqual(transferDetailText({ status: "running" }, t), "0 of 0 · 0 %");
});

test("cancelling keeps its own fixed message instead of the filename and percent", () => {
    assert.strictEqual(
        transferDetailText({ status: "cancelling", file: "gross.bin", bytesDone: 43, bytesTotal: 100 }, t),
        "Cancelling…",
    );
});

test("the fixed-text branches (done, cancelled, error) are untouched by the percent addition", () => {
    assert.strictEqual(transferDetailText({ status: "done", filesTransferred: 4 }, t), "4 transferred");
    assert.strictEqual(transferDetailText({ status: "cancelled" }, t), "Cancelled");
    assert.strictEqual(transferDetailText({ status: "error", connectionLost: true }, t), "Connection lost");
    assert.strictEqual(
        transferDetailText({ status: "error", message: "disk full" }, t),
        "Failed: disk full",
    );
});

test("a failure message that quotes a path keeps its slashes literal, not HTML-escaped", () => {
    assert.strictEqual(
        transferDetailText({ status: "error", message: "no such file: /root/xfer-ziel" }, t),
        "Failed: no such file: /root/xfer-ziel",
    );
});

import test from "node:test";
import assert from "node:assert";
import { sanitizeRemoteText } from "../remoteText.js";

test("plain text passes through", () => {
    assert.strictEqual(sanitizeRemoteText("~/projects/nexterm", 80), "~/projects/nexterm");
});

// Newlines would let a remote title forge an extra tooltip line that looks like one of ours.
test("ASCII control characters are removed", () => {
    assert.strictEqual(sanitizeRemoteText("a\nb\tc\x7f", 80), "abc");
});

// A single U+202E flips the rendering of everything after it, which is enough to make a shell
// title read like a tmux name. Length alone does not catch this.
test("bidi overrides and markers are removed", () => {
    assert.strictEqual(sanitizeRemoteText("deploy‮gnirts", 80), "deploygnirts");
    assert.strictEqual(sanitizeRemoteText("a‏b⁦c⁩d", 80), "abcd");
});

test("text is cut to the given length", () => {
    assert.strictEqual(sanitizeRemoteText("x".repeat(100), 80).length, 80);
});

// Cutting happens after stripping, so control characters cannot eat the budget and leave a
// shorter visible result than the caller asked for.
test("stripping happens before cutting", () => {
    assert.strictEqual(sanitizeRemoteText("‮".repeat(50) + "y".repeat(50), 10), "y".repeat(10));
});

test("anything that is not a string becomes empty", () => {
    for (const value of [undefined, null, 42, {}]) assert.strictEqual(sanitizeRemoteText(value, 80), "");
});

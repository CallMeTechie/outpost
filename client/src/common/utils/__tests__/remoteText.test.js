import test from "node:test";
import assert from "node:assert";
import { sanitizeRemoteText } from "../remoteText.js";

test("plain text passes through", () => {
    assert.strictEqual(sanitizeRemoteText("~/projects/outpost", 80), "~/projects/outpost");
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

// U+2028/U+2029 are not control characters and not in "Cf", but depending on surrounding
// white-space handling they can render as a line break - the same tooltip-line forgery that
// "\n" is stripped to prevent. Built via fromCodePoint rather than embedded literally: both
// are invisible whitespace-like characters, so a literal in the source would be indistinguishable
// from a stray blank in a diff or an editor.
test("line and paragraph separators are removed", () => {
    const separators = String.fromCodePoint(0x2028, 0x2029);
    assert.strictEqual(sanitizeRemoteText(`a${separators}b`, 80), "ab");
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

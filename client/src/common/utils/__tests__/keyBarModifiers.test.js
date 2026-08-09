import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLatchedModifiers } from "../keyBarModifiers.js";

const none = { ctrl: false, alt: false, shift: false };

test("passes data through untouched when nothing is latched", () => {
    assert.deepEqual(applyLatchedModifiers("c", none), { data: "c", consumed: false });
});

test("ctrl turns a letter into its control character", () => {
    assert.deepEqual(applyLatchedModifiers("c", { ...none, ctrl: true }), { data: "\x03", consumed: true });
});

test("ctrl works on an uppercase letter too", () => {
    assert.deepEqual(applyLatchedModifiers("C", { ...none, ctrl: true }), { data: "\x03", consumed: true });
});

test("ctrl+l clears the screen", () => {
    assert.equal(applyLatchedModifiers("l", { ...none, ctrl: true }).data, "\x0c");
});

test("ctrl+space is NUL", () => {
    assert.equal(applyLatchedModifiers(" ", { ...none, ctrl: true }).data, "\x00");
});

test("ctrl+? is DEL, which the mask alone would get wrong", () => {
    assert.equal(applyLatchedModifiers("?", { ...none, ctrl: true }).data, "\x7f");
});

test("alt prefixes an escape", () => {
    assert.deepEqual(applyLatchedModifiers("b", { ...none, alt: true }), { data: "\x1bb", consumed: true });
});

test("ctrl and alt together", () => {
    assert.equal(applyLatchedModifiers("c", { ...none, ctrl: true, alt: true }).data, "\x1b\x03");
});

test("shift has no effect on a typed character but is still spent", () => {
    assert.deepEqual(applyLatchedModifiers("a", { ...none, shift: true }), { data: "a", consumed: true });
});

test("multi-character input passes through and spends the latch", () => {
    assert.deepEqual(applyLatchedModifiers("abc", { ...none, ctrl: true }), { data: "abc", consumed: true });
});

test("an escape sequence from the bar itself is never transformed", () => {
    assert.deepEqual(applyLatchedModifiers("\x1b[Z", { ...none, ctrl: true }), { data: "\x1b[Z", consumed: true });
});

test("a non-ASCII character passes through and spends the latch", () => {
    assert.deepEqual(applyLatchedModifiers("ä", { ...none, ctrl: true }), { data: "ä", consumed: true });
});

test("a lone escape passes through", () => {
    assert.equal(applyLatchedModifiers("\x1b", { ...none, ctrl: true }).data, "\x1b");
});

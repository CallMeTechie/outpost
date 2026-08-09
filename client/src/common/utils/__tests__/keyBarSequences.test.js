import { test } from "node:test";
import assert from "node:assert/strict";
import { barKeySequence } from "../keyBarSequences.js";

const none = { ctrl: false, alt: false, shift: false };

test("escape is escape", () => {
    assert.equal(barKeySequence("escape", none), "\x1b");
});

test("escape ignores every latched modifier", () => {
    assert.equal(barKeySequence("escape", { ctrl: true, alt: true, shift: true }), "\x1b");
});

test("tab is a horizontal tab", () => {
    assert.equal(barKeySequence("tab", none), "\x09");
});

test("shift+tab is the backtab sequence", () => {
    assert.equal(barKeySequence("tab", { ...none, shift: true }), "\x1b[Z");
});

test("alt+tab prefixes an escape", () => {
    assert.equal(barKeySequence("tab", { ...none, alt: true }), "\x1b\x09");
});

test("ctrl+tab stays a plain tab - there is no agreed sequence for it", () => {
    assert.equal(barKeySequence("tab", { ...none, ctrl: true }), "\x09");
});

test("plain arrows", () => {
    assert.equal(barKeySequence("up", none), "\x1b[A");
    assert.equal(barKeySequence("down", none), "\x1b[B");
    assert.equal(barKeySequence("right", none), "\x1b[C");
    assert.equal(barKeySequence("left", none), "\x1b[D");
});

test("shift+arrow uses modifier parameter 2", () => {
    assert.equal(barKeySequence("up", { ...none, shift: true }), "\x1b[1;2A");
});

test("alt+arrow uses 3", () => {
    assert.equal(barKeySequence("left", { ...none, alt: true }), "\x1b[1;3D");
});

test("ctrl+arrow uses 5", () => {
    assert.equal(barKeySequence("right", { ...none, ctrl: true }), "\x1b[1;5C");
});

test("ctrl+shift+arrow uses 6", () => {
    assert.equal(barKeySequence("down", { ...none, ctrl: true, shift: true }), "\x1b[1;6B");
});

test("an unknown key yields null rather than a made-up sequence", () => {
    assert.equal(barKeySequence("f13", none), null);
});

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

test("shift wins over ctrl and alt on tab", () => {
    assert.equal(barKeySequence("tab", { ctrl: true, alt: true, shift: true }), "\x1b[Z");
});

test("a missing latch does not throw", () => {
    assert.equal(barKeySequence("tab", undefined), "\x09");
    assert.equal(barKeySequence("up", null), "\x1b[A");
});

// Home, End and the page keys: the artboard's second and third key group.
// Two different CSI shapes, which is the whole reason they are worth testing.

test("home and end use the arrows' CSI form", () => {
    assert.equal(barKeySequence("home", none), "\x1b[H");
    assert.equal(barKeySequence("end", none), "\x1b[F");
});

test("home and end take the modifier parameter like an arrow", () => {
    assert.equal(barKeySequence("home", { ctrl: false, alt: false, shift: true }), "\x1b[1;2H");
    assert.equal(barKeySequence("end", { ctrl: true, alt: false, shift: false }), "\x1b[1;5F");
});

test("page keys use the numeric tilde form, with the modifier after the number", () => {
    assert.equal(barKeySequence("pageup", none), "\x1b[5~");
    assert.equal(barKeySequence("pagedown", none), "\x1b[6~");
    assert.equal(barKeySequence("pageup", { ctrl: false, alt: false, shift: true }), "\x1b[5;2~");
    assert.equal(barKeySequence("pagedown", { ctrl: true, alt: false, shift: false }), "\x1b[6;5~");
});

test("the buried characters are literals, not sequences", () => {
    assert.equal(barKeySequence("pipe", none), "|");
    assert.equal(barKeySequence("tilde", none), "~");
    assert.equal(barKeySequence("dash", none), "-");
    assert.equal(barKeySequence("slash", none), "/");
});

test("a literal ignores latched modifiers rather than inventing an encoding", () => {
    // Same choice Ctrl+Tab makes above: terminals disagree on Ctrl+| and no
    // target application reads it, so a made-up sequence would be worse.
    assert.equal(barKeySequence("pipe", { ctrl: true, alt: true, shift: true }), "|");
});

test("an unknown key is still null", () => {
    assert.equal(barKeySequence("nonsense", none), null);
});

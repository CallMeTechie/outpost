import test from "node:test";
import assert from "node:assert/strict";
import { parseShortcut, formatShortcut, matchesShortcut } from "../shortcuts.js";

const event = (key, mods = {}) => ({
    key,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
});

test("parseShortcut splits modifiers from the one real key", () => {
    assert.deepEqual(parseShortcut("E"), { mods: new Set(), key: "e" });
    assert.deepEqual(parseShortcut("Ctrl+W"), { mods: new Set(["ctrl"]), key: "w" });
    assert.deepEqual(parseShortcut("Shift+Enter"), { mods: new Set(["shift"]), key: "enter" });
    assert.deepEqual(parseShortcut("Ctrl+Shift+F"), { mods: new Set(["ctrl", "shift"]), key: "f" });
});

test("parseShortcut treats cmd as meta", () => {
    assert.deepEqual(parseShortcut("Cmd+K"), { mods: new Set(["meta"]), key: "k" });
});

test("parseShortcut refuses anything that names no pressable key", () => {
    // Degrading to null means "no shortcut", which is visible. Returning a half-parsed
    // shortcut would print an accelerator that can never fire.
    assert.equal(parseShortcut(""), null);
    assert.equal(parseShortcut("   "), null);
    assert.equal(parseShortcut("Ctrl+"), null);
    assert.equal(parseShortcut("Ctrl"), null);
    assert.equal(parseShortcut("E+W"), null);
    assert.equal(parseShortcut(undefined), null);
    assert.equal(parseShortcut(42), null);
});

test("formatShortcut prints the symbols the artboard uses", () => {
    assert.equal(formatShortcut("E"), "E");
    assert.equal(formatShortcut("F2"), "F2");
    assert.equal(formatShortcut("Enter"), "↵");
    assert.equal(formatShortcut("Shift+Enter"), "⇧↵");
    assert.equal(formatShortcut("Delete"), "⌫");
    assert.equal(formatShortcut("Ctrl+W"), "⌃W");
    assert.equal(formatShortcut("Ctrl+Shift+F"), "⌃⇧F");
});

test("formatShortcut orders modifiers the same however they were written", () => {
    assert.equal(formatShortcut("Shift+Ctrl+F"), formatShortcut("Ctrl+Shift+F"));
});

test("formatShortcut renders nothing for an unparseable shortcut", () => {
    assert.equal(formatShortcut("Ctrl+"), "");
    assert.equal(formatShortcut(null), "");
});

test("matchesShortcut compares the key case-insensitively", () => {
    assert.ok(matchesShortcut("E", event("e")));
    assert.ok(matchesShortcut("E", event("E")));
});

test("matchesShortcut requires every modifier to agree, not just the named ones", () => {
    // The point of the rule: a bare letter must not fire on Ctrl+letter, or the menu would
    // swallow a binding the browser or the terminal owns.
    assert.ok(!matchesShortcut("E", event("e", { ctrl: true })));
    assert.ok(!matchesShortcut("E", event("e", { alt: true })));
    assert.ok(!matchesShortcut("Ctrl+W", event("w")));
    assert.ok(!matchesShortcut("Ctrl+W", event("w", { ctrl: true, shift: true })));
    assert.ok(matchesShortcut("Ctrl+W", event("w", { ctrl: true })));
});

test("matchesShortcut separates Enter from Shift+Enter", () => {
    assert.ok(matchesShortcut("Enter", event("Enter")));
    assert.ok(!matchesShortcut("Enter", event("Enter", { shift: true })));
    assert.ok(matchesShortcut("Shift+Enter", event("Enter", { shift: true })));
    assert.ok(!matchesShortcut("Shift+Enter", event("Enter")));
});

test("matchesShortcut is false for an unparseable shortcut or a missing event", () => {
    assert.ok(!matchesShortcut("Ctrl+", event("Control", { ctrl: true })));
    assert.ok(!matchesShortcut("E", null));
    assert.ok(!matchesShortcut(undefined, event("e")));
});

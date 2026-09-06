import test from "node:test";
import assert from "node:assert/strict";
import { isImeBackspace } from "../imeKeys.js";

const keydown = (key, extra = {}) => ({ type: "keydown", key, ...extra });

test("backspace during a composition belongs to the IME", () => {
    // The Android case: real key code, composition still open.
    assert.equal(isImeBackspace(keydown("Backspace", { isComposing: true }), false), true);
    // Chrome has been seen leaving isComposing unset; the tracked flag stands in.
    assert.equal(isImeBackspace(keydown("Backspace"), true), true);
});

test("backspace outside a composition is the terminal's", () => {
    assert.equal(isImeBackspace(keydown("Backspace", { isComposing: false }), false), false);
    assert.equal(isImeBackspace(keydown("Backspace"), false), false);
});

test("other keys are never held back, composing or not", () => {
    for (const key of ["Enter", "a", "Delete", "ArrowLeft", "Unidentified"]) {
        assert.equal(isImeBackspace(keydown(key, { isComposing: true }), true), false, key);
    }
});

test("only keydown counts; keyup and keypress pass through", () => {
    assert.equal(isImeBackspace({ type: "keyup", key: "Backspace", isComposing: true }, true), false);
    assert.equal(isImeBackspace({ type: "keypress", key: "Backspace", isComposing: true }, true), false);
    assert.equal(isImeBackspace(undefined, true), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { shouldShowKeyBar } from "../keyBarVisibility.js";

test("always and never override every detection", () => {
    for (const pointer of ["mouse", "touch", null]) {
        for (const media of [true, false]) {
            assert.equal(shouldShowKeyBar("always", pointer, media), true, `always/${pointer}/${media}`);
            assert.equal(shouldShowKeyBar("never", pointer, media), false, `never/${pointer}/${media}`);
        }
    }
});

test("auto: a mouse wins over whatever the device claims", () => {
    // The case reported twice: a tablet says it has no fine pointer, and the media query
    // believes it. One mouse movement settles it.
    assert.equal(shouldShowKeyBar("auto", "mouse", true), false);
    assert.equal(shouldShowKeyBar("auto", "mouse", false), false);
});

test("auto: touch input shows the bar even where the device claims a fine pointer", () => {
    // The mirror case: a laptop with a touchscreen reports a fine pointer, but someone
    // tapping it has no keyboard within reach either.
    assert.equal(shouldShowKeyBar("auto", "touch", false), true);
    assert.equal(shouldShowKeyBar("auto", "touch", true), true);
});

test("auto: before anything is pointed at, the media query decides", () => {
    // A phone must be right on the first frame, not after the first tap.
    assert.equal(shouldShowKeyBar("auto", null, true), true);
    assert.equal(shouldShowKeyBar("auto", null, false), false);
});

test("an unknown or missing mode behaves as auto", () => {
    // A corrupted or not-yet-loaded preference must not lock the bar on or off; auto is the
    // only value that keeps adapting.
    for (const mode of [undefined, null, "", "yes", 1, {}]) {
        assert.equal(shouldShowKeyBar(mode, "mouse", true), false, String(mode));
        assert.equal(shouldShowKeyBar(mode, "touch", false), true, String(mode));
        assert.equal(shouldShowKeyBar(mode, null, true), true, String(mode));
    }
});

test("a non-boolean media answer is coerced, not passed through", () => {
    // The caller reads it off matchMedia, which can be undefined where matchMedia is absent.
    assert.equal(shouldShowKeyBar("auto", null, undefined), false);
    assert.equal(shouldShowKeyBar("auto", null, null), false);
});

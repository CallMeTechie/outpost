import test from "node:test";
import assert from "node:assert";
import { VIEW_MODES, VIEW_DETAILS, VIEW_COMPACT, VIEW_GRID, normalizeViewMode, showsColumns, showsThumbnails }
    from "../viewModes.js";

test("the three modes stand in display order", () => {
    assert.deepStrictEqual(VIEW_MODES, [VIEW_DETAILS, VIEW_COMPACT, VIEW_GRID]);
});

// The stored value from before there were three views. Without this translation, anyone who set
// their preference would face a view that no longer exists.
test("a stored list is read as details", () => {
    assert.strictEqual(normalizeViewMode("list"), VIEW_DETAILS);
});

test("the three current values pass through unchanged", () => {
    for (const mode of VIEW_MODES) assert.strictEqual(normalizeViewMode(mode), mode);
});

// Without this fallback, the file list would remain empty on an unknown value instead of showing something.
test("anything else falls back to details", () => {
    for (const value of [undefined, null, "", "tiles", 7, {}, []]) {
        assert.strictEqual(normalizeViewMode(value), VIEW_DETAILS, JSON.stringify(value));
    }
});

test("only details shows the columns", () => {
    assert.strictEqual(showsColumns(VIEW_DETAILS), true);
    assert.strictEqual(showsColumns(VIEW_COMPACT), false);
    assert.strictEqual(showsColumns(VIEW_GRID), false);
});

test("only grid shows thumbnails", () => {
    assert.strictEqual(showsThumbnails(VIEW_GRID), true);
    assert.strictEqual(showsThumbnails(VIEW_DETAILS), false);
    assert.strictEqual(showsThumbnails(VIEW_COMPACT), false);
});

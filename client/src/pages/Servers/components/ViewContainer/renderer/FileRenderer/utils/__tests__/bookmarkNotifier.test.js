import test from "node:test";
import assert from "node:assert";
import { publishBookmarksChanged, subscribeToBookmarksChanged, paneAffectedByBookmarkChange }
    from "../bookmarkNotifier.js";

test("a subscriber is told which entry changed", () => {
    const seen = [];
    const unsubscribe = subscribeToBookmarksChanged((e) => seen.push(e));
    publishBookmarksChanged({ entryId: 7 });
    unsubscribe();
    assert.deepStrictEqual(seen, [{ entryId: 7 }]);
});

test("unsubscribing actually stops the delivery", () => {
    const seen = [];
    subscribeToBookmarksChanged((e) => seen.push(e))();
    publishBookmarksChanged({ entryId: 7 });
    assert.deepStrictEqual(seen, []);
});

test("the filter runs on entryId, not sessionId", () => {
    // Two tiles on the same server are two separate sessions with different sessionIds -
    // moveNotifier's paneAffectedByMove bails out with sessionId !== sourceSessionId and would
    // never reach the second tile. That is exactly why this module exists.
    assert.strictEqual(paneAffectedByBookmarkChange({ entryId: 7, changedEntryId: 7 }), true);
    assert.strictEqual(paneAffectedByBookmarkChange({ entryId: 7, changedEntryId: 8 }), false);
});

test("a tile without an entryId is never affected", () => {
    assert.strictEqual(paneAffectedByBookmarkChange({ entryId: null, changedEntryId: 7 }), false);
    assert.strictEqual(paneAffectedByBookmarkChange({ entryId: undefined, changedEntryId: undefined }), false);
});

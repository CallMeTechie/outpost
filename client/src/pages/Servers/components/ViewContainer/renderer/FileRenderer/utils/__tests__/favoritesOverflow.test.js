import test from "node:test";
import assert from "node:assert";
import { splitForOverflow } from "../favoritesOverflow.js";

const gap = 8;
const chevronWidth = 32;

test("everything fits, no chevron is needed", () => {
    const result = splitForOverflow({ widths: [80, 60, 70], available: 400, gap, chevronWidth });
    assert.deepStrictEqual(result, { visible: 3, hidden: [] });
});

test("one chip too many: the last one moves into the overflow", () => {
    // 80 + 8 + 60 + 8 + 70 = 226; with the chevron only the first two fit into 200.
    const result = splitForOverflow({ widths: [80, 60, 70], available: 200, gap, chevronWidth });
    assert.deepStrictEqual(result, { visible: 2, hidden: [2] });
});

test("the chevron itself takes the space of the last chip", () => {
    // Two chips fit on their own (80 + 8 + 60 = 148 <= 150), but the row as a whole does not
    // (226 > 150), so a chevron is needed - and its 32 plus the gap leave room for one chip only.
    const result = splitForOverflow({ widths: [80, 60, 70], available: 150, gap, chevronWidth });
    assert.deepStrictEqual(result, { visible: 1, hidden: [1, 2] });
});

test("not even one chip fits: zero visible is a valid result, never a truncated chip", () => {
    // A tile in the grid layout is a third of the view width - this is not a theoretical case.
    const result = splitForOverflow({ widths: [120, 60], available: 100, gap, chevronWidth });
    assert.deepStrictEqual(result, { visible: 0, hidden: [0, 1] });
});

test("no bookmarks at all is not an overflow", () => {
    assert.deepStrictEqual(splitForOverflow({ widths: [], available: 400, gap, chevronWidth }), { visible: 0, hidden: [] });
});

test("a width of zero (not yet measured) does not fake a fit", () => {
    assert.deepStrictEqual(splitForOverflow({ widths: [80], available: 0, gap, chevronWidth }), { visible: 0, hidden: [0] });
});

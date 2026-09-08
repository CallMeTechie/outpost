const test = require("node:test");
const assert = require("node:assert");
const { renumberPositions, orderRequestIsComplete } = require("../bookmarkOrder");

test("positions come out gapless from 0, in the order given", () => {
    assert.deepStrictEqual(renumberPositions([9, 3, 7]), [
        { id: 9, position: 0 }, { id: 3, position: 1 }, { id: 7, position: 2 },
    ]);
});

test("an unchanged order still renumbers to the same, stable result", () => {
    assert.deepStrictEqual(renumberPositions([1, 2]), [{ id: 1, position: 0 }, { id: 2, position: 1 }]);
});

test("an empty list is valid and produces nothing", () => {
    assert.deepStrictEqual(renumberPositions([]), []);
});

test("the id sets must match exactly - a missing id means the pane sorted on a stale list", () => {
    assert.strictEqual(orderRequestIsComplete([1, 2], [1, 2, 3]), false);
});

test("an unknown id is refused too", () => {
    assert.strictEqual(orderRequestIsComplete([1, 2, 99], [1, 2]), false);
});

test("the same set in a different order is complete", () => {
    assert.strictEqual(orderRequestIsComplete([2, 1], [1, 2]), true);
});

test("a duplicate id is not a valid ordering", () => {
    assert.strictEqual(orderRequestIsComplete([1, 1], [1, 2]), false);
});

import test from "node:test";
import assert from "node:assert";
import { MAX_TRANSFER_PATHS, exceedsTransferPathLimit } from "../transferLimits.js";

const paths = (count) => Array.from({ length: count }, (_, i) => `/src/${i}`);

// Named on purpose rather than derived from the constant: this is the number the server was read
// off, and a silent move of either side is exactly what this file exists to catch.
test("the cap is 256 paths", () => {
    assert.strictEqual(MAX_TRANSFER_PATHS, 256);
});

test("a list at the cap still goes out", () => {
    assert.strictEqual(exceedsTransferPathLimit(paths(MAX_TRANSFER_PATHS)), false);
});

test("one path past the cap is stopped before it is sent", () => {
    assert.strictEqual(exceedsTransferPathLimit(paths(MAX_TRANSFER_PATHS + 1)), true);
});

test("an ordinary drop is nowhere near the cap", () => {
    assert.strictEqual(exceedsTransferPathLimit(paths(1)), false);
    assert.strictEqual(exceedsTransferPathLimit([]), false);
});

// The caller reads a drag payload, and dropTransfer.js is the only thing that guarantees paths is
// an array — a caller that ever skips it must not have the cap throw in its face.
test("a missing list is not over the cap", () => {
    assert.strictEqual(exceedsTransferPathLimit(undefined), false);
    assert.strictEqual(exceedsTransferPathLimit(null), false);
});

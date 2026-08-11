import test from "node:test";
import assert from "node:assert";
import { transferPercent } from "../transferProgress.js";

test("file counts drive the bar once a total is known", () => {
    assert.strictEqual(transferPercent({ filesDone: 1, filesTotal: 4 }), 25);
    assert.strictEqual(transferPercent({ filesDone: 4, filesTotal: 4 }), 100);
});

// Bytes only until the first file count arrives — a single large file in flight otherwise sits at
// zero for its whole run.
test("bytes drive the bar while no file total is known", () => {
    assert.strictEqual(transferPercent({ filesTotal: 0, bytesDone: 3, bytesTotal: 4 }), 75);
});

test("file counts win over bytes when both are there", () => {
    assert.strictEqual(transferPercent({ filesDone: 1, filesTotal: 2, bytesDone: 1, bytesTotal: 100 }), 50);
});

test("a transfer that has told nothing yet sits at zero", () => {
    assert.strictEqual(transferPercent({}), 0);
    assert.strictEqual(transferPercent(), 0);
    assert.strictEqual(transferPercent({ filesTotal: 0, bytesTotal: 0 }), 0);
});

// The numbers are the server's. Inconsistent ones must not push the bar out of its track.
test("a done count ahead of its total stops at the end of the bar", () => {
    assert.strictEqual(transferPercent({ filesDone: 9, filesTotal: 4 }), 100);
    assert.strictEqual(transferPercent({ filesTotal: 0, bytesDone: 9, bytesTotal: 4 }), 100);
});

test("a negative count stays at the start of the bar", () => {
    assert.strictEqual(transferPercent({ filesDone: -2, filesTotal: 4 }), 0);
    assert.strictEqual(transferPercent({ filesTotal: 0, bytesDone: -2, bytesTotal: 4 }), 0);
});

test("a missing count is zero rather than a width the browser throws away", () => {
    assert.strictEqual(transferPercent({ filesTotal: 4 }), 0);
    assert.strictEqual(transferPercent({ filesDone: "many", filesTotal: 4 }), 0);
});

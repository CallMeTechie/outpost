import test from "node:test";
import assert from "node:assert";
import { transferPercent } from "../transferProgress.js";

test("file counts drive the bar once no byte total is known", () => {
    assert.strictEqual(transferPercent({ filesDone: 1, filesTotal: 4 }), 25);
    assert.strictEqual(transferPercent({ filesDone: 4, filesTotal: 4 }), 100);
});

test("bytes drive the bar while no file total is known", () => {
    assert.strictEqual(transferPercent({ filesTotal: 0, bytesDone: 3, bytesTotal: 4 }), 75);
});

test("bytes win over file counts when both are there", () => {
    assert.strictEqual(transferPercent({ filesDone: 1, filesTotal: 2, bytesDone: 1, bytesTotal: 100 }), 1);
});

// A single file in flight has filesTotal stuck at 1 and filesDone at 0 for its whole run — the
// bug this suite guards against. Bytes must carry the bar instead.
test("a single large file in flight is read from its bytes, not its file count", () => {
    assert.strictEqual(transferPercent({ filesDone: 0, filesTotal: 1, bytesDone: 2_000_000_000, bytesTotal: 4_000_000_000 }), 50);
});

test("many files in flight are also read from their combined bytes", () => {
    assert.strictEqual(transferPercent({ filesDone: 3, filesTotal: 10, bytesDone: 50, bytesTotal: 100 }), 50);
});

// No byte total yet — mid directory-walk, or a transfer made up entirely of empty files — falls
// back to the file count instead of freezing at zero.
test("file counts are the fallback once there is no byte total to read", () => {
    assert.strictEqual(transferPercent({ filesDone: 2, filesTotal: 4, bytesDone: 0, bytesTotal: 0 }), 50);
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

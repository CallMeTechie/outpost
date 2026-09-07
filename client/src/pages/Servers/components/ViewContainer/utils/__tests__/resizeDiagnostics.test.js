import test from "node:test";
import assert from "node:assert/strict";
import { pushBounded } from "../resizeDiagnostics.js";

test("hängt an, solange Platz ist", () => {
    assert.deepEqual(pushBounded([], "a", 3), ["a"]);
    assert.deepEqual(pushBounded(["a", "b"], "c", 3), ["a", "b", "c"]);
});

test("wirft vorne weg, statt zu wachsen", () => {
    // Eine Messung, die unbegrenzt wächst, verändert durch Speicherdruck genau das
    // Verhalten, das sie finden soll.
    assert.deepEqual(pushBounded(["a", "b", "c"], "d", 3), ["b", "c", "d"]);
    assert.deepEqual(pushBounded(["a", "b", "c", "d"], "e", 3), ["c", "d", "e"]);
});

test("rührt die übergebene Liste nicht an", () => {
    const before = ["a", "b", "c"];
    pushBounded(before, "d", 3);
    assert.deepEqual(before, ["a", "b", "c"]);
});

test("die Grenze wird eingehalten, auch aus einer zu langen Liste heraus", () => {
    const long = Array.from({ length: 10 }, (_, i) => i);
    assert.equal(pushBounded(long, 99, 3).length, 3);
    assert.deepEqual(pushBounded(long, 99, 3), [8, 9, 99]);
});

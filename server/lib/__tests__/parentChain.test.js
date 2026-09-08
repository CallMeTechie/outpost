const test = require("node:test");
const assert = require("node:assert");
const { parentChain } = require("../parentChain");

test("candidates run from the inside out, the root is the last link", () => {
    assert.deepStrictEqual(parentChain("/volume1/docker/alt"), ["/volume1/docker", "/volume1", "/"]);
});

test("a path directly under the root yields only the root", () => {
    assert.deepStrictEqual(parentChain("/volume1"), ["/"]);
});

test("the root itself has no candidates above it", () => {
    assert.deepStrictEqual(parentChain("/"), []);
});

test("a path deeper than maxDepth is not climbed at all", () => {
    // The caller falls back to the home directory instead - climbing 200 levels would mean 200
    // full directory listings before the pane shows anything.
    const deep = "/" + Array.from({ length: 40 }, (_, i) => `d${i}`).join("/");
    assert.deepStrictEqual(parentChain(deep, 32), []);
});

test("exactly maxDepth levels is still climbed", () => {
    const atLimit = "/" + Array.from({ length: 32 }, (_, i) => `d${i}`).join("/");
    assert.strictEqual(parentChain(atLimit, 32).length, 32);
});

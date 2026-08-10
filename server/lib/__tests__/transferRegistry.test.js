const test = require("node:test");
const assert = require("node:assert");
const { reserve, release, releaseSession, countFor, MAX_CROSS_TRANSFERS } = require("../fileTransfer/registry");

test("a transfer counts for both of its sessions", () => {
    assert.strictEqual(reserve("t1", ["src", "dst"]), true);
    assert.strictEqual(countFor("src"), 1);
    assert.strictEqual(countFor("dst"), 1);
    release("t1");
    assert.strictEqual(countFor("src"), 0);
});

// The whole point: two transfers sharing a source but not a destination.
test("the source limit holds across different destinations", () => {
    for (let i = 0; i < MAX_CROSS_TRANSFERS; i += 1) {
        assert.strictEqual(reserve(`a${i}`, ["shared-src", `dst${i}`]), true);
    }
    assert.strictEqual(reserve("one-too-many", ["shared-src", "other-dst"]), false);
    for (let i = 0; i < MAX_CROSS_TRANSFERS; i += 1) release(`a${i}`);
});

test("a refused reservation leaves nothing behind", () => {
    for (let i = 0; i < MAX_CROSS_TRANSFERS; i += 1) reserve(`b${i}`, ["busy", `d${i}`]);
    assert.strictEqual(reserve("refused", ["busy", "fresh-dst"]), false);
    assert.strictEqual(countFor("fresh-dst"), 0, "a refused reservation must not half-register");
    for (let i = 0; i < MAX_CROSS_TRANSFERS; i += 1) release(`b${i}`);
});

test("releasing a session drops all of its transfers", () => {
    reserve("c1", ["gone", "dst1"]);
    reserve("c2", ["dst2", "gone"]);
    releaseSession("gone");
    assert.strictEqual(countFor("gone"), 0);
    assert.strictEqual(countFor("dst1"), 0, "the other side must be released too");
    assert.strictEqual(countFor("dst2"), 0);
});

test("releasing an unknown key is a no-op", () => {
    assert.doesNotThrow(() => release("nope"));
    assert.doesNotThrow(() => releaseSession("nope"));
});

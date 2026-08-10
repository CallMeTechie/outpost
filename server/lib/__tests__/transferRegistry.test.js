const test = require("node:test");
const assert = require("node:assert");
const { reserve, release, releaseSession, countFor, MAX_CROSS_TRANSFERS, _getInternalState } = require("../fileTransfer/registry");

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
    // releaseSession deliberately leaves c1/c2 themselves reserved (see the fixture below for why)
    // — simulate the transfer's own eventual release() so this test does not leak a tombstone into
    // the ones that follow it in this process.
    release("c1");
    release("c2");
});

test("releasing an unknown key is a no-op", () => {
    assert.doesNotThrow(() => release("nope"));
    assert.doesNotThrow(() => releaseSession("nope"));
});

test("reusing a key is rejected and does not corrupt state", () => {
    assert.strictEqual(reserve("reused", ["a", "b"]), true);
    assert.strictEqual(countFor("a"), 1);
    assert.strictEqual(countFor("b"), 1);
    // Try to reuse the same key with different sessions
    assert.strictEqual(reserve("reused", ["c", "d"]), false);
    // The original sessions should still be counted
    assert.strictEqual(countFor("a"), 1);
    assert.strictEqual(countFor("b"), 1);
    assert.strictEqual(countFor("c"), 0);
    assert.strictEqual(countFor("d"), 0);
    // After release, both original sessions should be back to 0
    release("reused");
    assert.strictEqual(countFor("a"), 0);
    assert.strictEqual(countFor("b"), 0);
});

// Finding 3 (fix round 1): SessionManager.remove calls releaseSession while the transfer this key
// belongs to may still be running on the surviving side. release(key) only ever receives the bare
// key, with no way to tell an old reservation apart from a new one under the same string — so the
// only way a belated release(key) can stay harmless is if nothing new was ever let onto that exact
// key in between.
test("a key survives releaseSession until its own release — a third party cannot move in early", () => {
    assert.strictEqual(reserve("shared-key", ["gone", "survivor"]), true);

    releaseSession("gone");
    assert.strictEqual(countFor("gone"), 0);
    assert.strictEqual(countFor("survivor"), 0, "the other side must be released too");

    // A late-arriving third party — e.g. a second socket on the same shared destination session,
    // picking a client-chosen transferId that happens to collide — must be refused, not handed
    // the tombstoned key.
    assert.strictEqual(reserve("shared-key", ["newcomer", "survivor"]), false,
        "the key must stay blocked until its own transfer releases it");
    assert.strictEqual(countFor("newcomer"), 0, "a refused reservation must not half-register");

    // The original transfer's own, delayed release() now arrives — the one release(key) still
    // owns. It must have no effect on anyone but the tombstone itself.
    release("shared-key");
    assert.strictEqual(countFor("survivor"), 0);
    assert.strictEqual(countFor("newcomer"), 0);

    // The key is cleanly available again — no residue from the vanished session lingers.
    assert.strictEqual(reserve("shared-key", ["newcomer", "survivor"]), true);
    assert.strictEqual(countFor("newcomer"), 1);
    assert.strictEqual(countFor("survivor"), 1);
    release("shared-key");
});

test("releasing all transfers leaves no orphaned session entries", () => {
    assert.strictEqual(reserve("orphan1", ["sess1", "sess2"]), true);
    assert.strictEqual(reserve("orphan2", ["sess3", "sess4"]), true);
    const stateBefore = _getInternalState();
    assert.strictEqual(stateBefore.sessionCount, 4, "4 sessions registered");
    release("orphan1");
    release("orphan2");
    const stateAfter = _getInternalState();
    assert.strictEqual(stateAfter.sessionCount, 0, "no orphaned entries after release");
    assert.strictEqual(stateAfter.keyCount, 0, "no orphaned keys");
});

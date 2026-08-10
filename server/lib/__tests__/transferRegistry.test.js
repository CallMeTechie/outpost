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

// Fix round 3, Finding 1: releaseSession used to drop the count for every participant of a key,
// not just the vanished session's own — reasoning that a stuck cross-transfer connection attempt
// could otherwise strand the slot forever. Measured instead: it cannot (see registry.js's own
// comment on releaseSession — the connection attempt is now deadline-bound, and even without that
// deadline the engine session is force-closed once either side's own session ends). With a release
// now guaranteed, holding the slot until it actually arrives is what keeps countFor honest while
// the auxiliary connections it accounts for are still genuinely open.
test("releasing a session forgets only its own bookkeeping, not its transfer partners'", () => {
    reserve("c1", ["gone", "dst1"]);
    reserve("c2", ["dst2", "gone"]);
    releaseSession("gone");
    assert.strictEqual(countFor("gone"), 0);
    assert.strictEqual(countFor("dst1"), 1, "a partner's own transfer still holds its slot — it is not released early");
    assert.strictEqual(countFor("dst2"), 1);
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

// Fix round 2, Finding 2 (superseded by fix round 3's Finding 1, still guards the same class of
// mutation): mutating releaseSession to touch a participant's key set at all — rather than just
// forgetting the vanished session's own — must be caught. A session that shares a key with the
// vanished one AND holds a completely unrelated second transfer at the same time now keeps BOTH
// slots; neither is released early.
test("releasing a session must not touch a shared participant's own count at all", () => {
    assert.strictEqual(reserve("shared-a", ["gone2", "shared-participant"]), true);
    assert.strictEqual(reserve("shared-b", ["shared-participant", "third-party"]), true);
    assert.strictEqual(countFor("shared-participant"), 2);

    releaseSession("gone2");

    assert.strictEqual(countFor("gone2"), 0);
    assert.strictEqual(countFor("shared-participant"), 2,
        "neither of the shared participant's transfers is released early");
    assert.strictEqual(countFor("third-party"), 1, "unaffected");

    release("shared-a");
    release("shared-b");
});

// Finding 3 (fix round 1), numbers updated for fix round 3's Finding 1: SessionManager.remove
// calls releaseSession while the transfer this key belongs to is still running on the surviving
// side. release(key) only ever receives the bare key, with no way to tell an old reservation apart
// from a new one under the same string — so the only way a belated release(key) can stay harmless
// is if nothing new was ever let onto that exact key in between. releaseSession no longer touches
// byKey at all now, so this is simply reserve()'s own byKey.has(key) guard doing its ordinary job —
// the surviving side's count staying at 1 (not released early) reinforces the same guarantee from
// the other direction.
test("a key survives releaseSession until its own release — a third party cannot move in early", () => {
    assert.strictEqual(reserve("shared-key", ["gone", "survivor"]), true);

    releaseSession("gone");
    assert.strictEqual(countFor("gone"), 0);
    assert.strictEqual(countFor("survivor"), 1, "the surviving side's own transfer still holds its slot");

    // A late-arriving third party — e.g. a second socket on the same shared destination session,
    // picking a client-chosen transferId that happens to collide — must be refused, not handed
    // a key that is still in use.
    assert.strictEqual(reserve("shared-key", ["newcomer", "survivor"]), false,
        "the key must stay blocked until its own transfer releases it");
    assert.strictEqual(countFor("newcomer"), 0, "a refused reservation must not half-register");

    // The original transfer's own release() now arrives.
    release("shared-key");
    assert.strictEqual(countFor("survivor"), 0);
    assert.strictEqual(countFor("newcomer"), 0);

    // The key is cleanly available again — no residue from the vanished session lingers.
    assert.strictEqual(reserve("shared-key", ["newcomer", "survivor"]), true);
    assert.strictEqual(countFor("newcomer"), 1);
    assert.strictEqual(countFor("survivor"), 1);
    release("shared-key");
});

// Fix round 3, Finding 1: the point of leaving the count occupied. Before this fix, a vanished
// session's own slot (and its surviving partner's) was freed immediately, so repeating "reserve,
// then let the source vanish" let a party accumulate far more genuinely open auxiliary connections
// than MAX_CROSS_TRANSFERS while countFor kept reporting the cap as untouched — measured at 50
// simultaneously open connections against a cap of 2 (see the report for fix round 3). With the
// count honest, the cap enforces the limit even while a vanished session's former transfers are
// still winding down on the surviving side.
test("countFor keeps the cap honest across repeated session churn on the surviving side", () => {
    for (let i = 0; i < MAX_CROSS_TRANSFERS; i += 1) {
        assert.strictEqual(reserve(`churn${i}`, [`gone${i}`, "surviving-dest"]), true);
        releaseSession(`gone${i}`);
    }
    assert.strictEqual(countFor("surviving-dest"), MAX_CROSS_TRANSFERS);
    assert.strictEqual(reserve("one-too-many", ["fresh-source", "surviving-dest"]), false,
        "the cap must still hold — the vanished sessions must not have opened up phantom capacity");

    for (let i = 0; i < MAX_CROSS_TRANSFERS; i += 1) release(`churn${i}`);
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

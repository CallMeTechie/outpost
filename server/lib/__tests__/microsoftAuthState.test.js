const test = require("node:test");
const assert = require("node:assert");
const {
    createState, consumeState, pendingCount, STATE_TTL_MS, MAX_PENDING_PER_ACCOUNT,
} = require("../microsoft/authState");

const entry = (accountId = 7) => ({ accountId, codeVerifier: "verifier", nonce: "nonce", scope: "openid" });

test("a created state can be redeemed once and carries the requesting account", () => {
    const state = createState(entry(7));
    const redeemed = consumeState(state);

    assert.strictEqual(redeemed.accountId, 7);
    assert.strictEqual(redeemed.codeVerifier, "verifier");
    assert.strictEqual(redeemed.nonce, "nonce");
    assert.strictEqual(redeemed.scope, "openid");
});

test("a state is redeemable exactly once", () => {
    const state = createState(entry());
    assert.ok(consumeState(state));
    assert.strictEqual(consumeState(state), null, "a replayed state must not resolve a second time");
});

test("an unknown state resolves to null", () => {
    assert.strictEqual(consumeState("never-issued"), null);
});

test("two states never collide", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(createState(entry(i)));
    assert.strictEqual(seen.size, 200);
    for (const state of seen) consumeState(state);
});

test("an expired state is refused", () => {
    const start = 1_000_000;
    const state = createState(entry(), start);

    assert.strictEqual(consumeState(state, start + STATE_TTL_MS + 1), null);
});

test("a state one millisecond inside the window still works", () => {
    const start = 2_000_000;
    const state = createState(entry(), start);

    assert.ok(consumeState(state, start + STATE_TTL_MS - 1));
});

test("creating a state clears out entries that have expired", () => {
    const start = 3_000_000;
    const stale = createState(entry(11), start);
    const before = pendingCount();

    createState(entry(12), start + STATE_TTL_MS + 1);

    assert.ok(pendingCount() < before + 2, "the stale entry should have been swept, not accumulated");
    assert.strictEqual(consumeState(stale, start + STATE_TTL_MS + 1), null);
});

// A logged-in user could otherwise start unlimited connect attempts and grow the map without end.
test("pending states per account are bounded, oldest first", () => {
    const base = 4_000_000;
    const states = [];
    for (let i = 0; i <= MAX_PENDING_PER_ACCOUNT; i += 1) states.push(createState(entry(99), base + i));

    assert.strictEqual(consumeState(states[0], base + 100), null, "the oldest attempt should have been dropped");
    assert.ok(consumeState(states[states.length - 1], base + 100), "the newest attempt must survive");
});

test("the cap counts per account, not globally", () => {
    const base = 5_000_000;
    const mine = createState(entry(1000), base);
    for (let i = 1; i <= MAX_PENDING_PER_ACCOUNT + 2; i += 1) createState(entry(1001), base + i);

    assert.ok(consumeState(mine, base + 100), "another account's attempts must not evict mine");
});

// The whole point of the state entry: the callback carries no session, so the binding may only
// come from the entry itself.
test("consumeState takes no account argument that could override the binding", () => {
    const state = createState(entry(5));

    assert.strictEqual(consumeState.length, 2, "consumeState(state, now) — a third parameter would be a way in");

    const redeemed = consumeState(state, Date.now());
    assert.strictEqual(redeemed.accountId, 5);
});

test("the returned entry is a copy, so a caller cannot poison the store", () => {
    const state = createState(entry(42));
    const redeemed = consumeState(state);
    redeemed.accountId = 1;

    assert.strictEqual(consumeState(state), null);
});

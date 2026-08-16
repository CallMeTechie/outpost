import test from "node:test";
import assert from "node:assert";
import { selectEvictions, normalizeTabName, normalizeTabNumber, normalizeTabUsedAt, TAB_IDENTITY_CAP } from "../tabIdentity.js";

const entry = (usedAt) => ({ name: "x", usedAt });

test("nothing is evicted while there is room", () => {
    assert.deepStrictEqual(selectEvictions({ a: entry(1), b: entry(2) }, ["a"], 10), []);
});

test("the oldest unprotected entry goes first", () => {
    assert.deepStrictEqual(selectEvictions({ a: entry(3), b: entry(1), c: entry(2) }, [], 2), ["b"]);
});

// The whole point of the cap's exception. A tmux tab left open in the background for days is
// exactly the least-recently-used entry — evicting it would rename a tab nobody touched, which
// is the one thing this feature promises never to happen.
test("a protected session is never evicted, however old", () => {
    assert.deepStrictEqual(selectEvictions({ a: entry(1), b: entry(2), c: entry(3) }, ["a"], 2), ["b"]);
});

test("the cap is exceeded rather than touching a protected session", () => {
    assert.deepStrictEqual(selectEvictions({ a: entry(1), b: entry(2), c: entry(3) }, ["a", "b", "c"], 1), []);
});

test("several are evicted at once when far over the cap", () => {
    const entries = { a: entry(1), b: entry(2), c: entry(3), d: entry(4) };
    assert.deepStrictEqual(selectEvictions(entries, [], 2).sort(), ["a", "b"]);
});

// A missing session list must not read as "nothing is open" — that would make every entry a
// candidate. Treat it as "nothing is known", which protects everything.
test("an absent session list evicts nothing", () => {
    const entries = { a: entry(1), b: entry(2) };
    assert.deepStrictEqual(selectEvictions(entries, undefined, 1), []);
    assert.deepStrictEqual(selectEvictions(entries, null, 1), []);
});

// Five entries, cap 2, three protected: only two are candidates, but the cap puts the excess
// at three. slice(0, excess) must clamp to what candidates actually has rather than assume
// there are enough unprotected entries to cover the excess.
test("fewer candidates than the excess evicts only what is available", () => {
    const entries = { a: entry(1), b: entry(2), c: entry(3), d: entry(4), e: entry(5) };
    assert.deepStrictEqual(selectEvictions(entries, ["a", "b", "c"], 2).sort(), ["d", "e"]);
});

test("the cap is a whole number above zero", () => {
    assert.ok(Number.isInteger(TAB_IDENTITY_CAP) && TAB_IDENTITY_CAP > 0);
});

// --- normalizeTabName ---

test("surrounding whitespace is trimmed", () => {
    assert.strictEqual(normalizeTabName("  Deploy Prod  "), "Deploy Prod");
});

test("a name is cut to 40 characters", () => {
    assert.strictEqual(normalizeTabName("x".repeat(60)).length, 40);
});

// Empty is the only way back to the automatic text, so it must be unambiguous.
test("whitespace only counts as empty", () => {
    assert.strictEqual(normalizeTabName("   "), undefined);
    assert.strictEqual(normalizeTabName(""), undefined);
});

// A custom name is usually pasted, not typed — out of a ticket, a chat message. "Self-chosen"
// is no guarantee of "free of bidi characters", and this text goes into the visible tab.
test("control and bidi characters are removed", () => {
    assert.strictEqual(normalizeTabName("Deploy‮dorP"), "DeploydorP");
});

test("anything that is not a string counts as empty", () => {
    for (const value of [undefined, null, 42, {}]) assert.strictEqual(normalizeTabName(value), undefined);
});

// --- normalizeTabNumber ---

test("a positive integer is kept as-is", () => {
    assert.strictEqual(normalizeTabNumber(2), 2);
});

// assignNumbers (tabLabel.js) carries a stored number forward via Math.max, where a single NaN,
// non-numeric, zero, or negative entry would poison every number handed out afterwards. A hand-
// edited localStorage entry must not reach that far - it has to be dropped here first.
test("a corrupt stored number is dropped, exactly like a corrupt name", () => {
    for (const bad of [NaN, "2", null, undefined, 0, -1, 1.5, {}]) {
        assert.strictEqual(normalizeTabNumber(bad), undefined);
    }
});

// --- normalizeTabUsedAt ---

test("a finite number is kept as-is", () => {
    assert.strictEqual(normalizeTabUsedAt(1700000000000), 1700000000000);
});

// selectEvictions subtracts usedAt directly to order candidates - a missing or non-numeric value
// would turn that subtraction into NaN and leave the entry's position in the sort undefined. 0 is
// the safe fallback: it sorts as "oldest", which only ever moves a closed entry's eviction sooner,
// never costs a still-open (and therefore protected-by-id) entry its name or number.
test("a missing or invalid usedAt falls back to 0, not NaN", () => {
    for (const bad of [undefined, null, NaN, "1700000000000", {}]) {
        assert.strictEqual(normalizeTabUsedAt(bad), 0);
    }
});

// The end-to-end case selectEvictions itself would otherwise be exposed to: an entry written by a
// caller that forgot the timestamp (Task 6's rename path is the one in mind) must not corrupt the
// ordering of every other candidate the way a raw NaN would.
test("an entry with a corrupt usedAt sorts as oldest, without corrupting the rest of the order", () => {
    const entries = {
        a: { name: "x", usedAt: normalizeTabUsedAt(undefined) },
        b: { name: "x", usedAt: 2 },
        c: { name: "x", usedAt: 1 },
    };
    assert.deepStrictEqual(selectEvictions(entries, [], 1), ["a", "c"]);
});

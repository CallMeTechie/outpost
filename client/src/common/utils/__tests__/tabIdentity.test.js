import test from "node:test";
import assert from "node:assert";
import { selectEvictions, normalizeTabName, TAB_IDENTITY_CAP } from "../tabIdentity.js";

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

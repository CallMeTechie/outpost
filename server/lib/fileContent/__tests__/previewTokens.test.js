const test = require("node:test");
const assert = require("node:assert/strict");
const { issue, resolve, revokeForSession, TTL_MS, MAX_TOKENS, _reset, _size } = require("../previewTokens");

test.beforeEach(() => _reset());

test("a fresh token resolves to the session it was issued for", () => {
    const { token, expiresAt } = issue("sess-1", "tok-abc");
    assert.ok(token);
    assert.deepEqual(resolve(token), { sessionId: "sess-1", sessionToken: "tok-abc", expiresAt });
});

test("two tokens are never the same", () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(issue("sess", "tok").token);
    assert.equal(seen.size, 50);
});

test("a token expires and is dropped on the way out", () => {
    const now = 1_000_000;
    const { token } = issue("sess-1", "tok", now);
    assert.ok(resolve(token, now + TTL_MS - 1));
    assert.equal(resolve(token, now + TTL_MS), null);
    // Deleted rather than left to be found again by a later probe.
    assert.equal(_size(), 0);
});

test("an unknown token resolves to null rather than throwing", () => {
    for (const bad of ["nope", "", null, undefined, 42, {}]) {
        assert.equal(resolve(bad), null, String(bad));
    }
});

test("issuing refuses input that would produce an unusable token", () => {
    assert.equal(issue("", "tok"), null);
    assert.equal(issue("sess", ""), null);
    assert.equal(issue(null, "tok"), null);
    assert.equal(issue("sess", undefined), null);
    assert.equal(_size(), 0);
});

test("expired entries are pruned when a new token is issued", () => {
    const now = 1_000_000;
    issue("old", "tok", now);
    assert.equal(_size(), 1);
    issue("new", "tok", now + TTL_MS + 1);
    // The old one is gone, not merely unreachable.
    assert.equal(_size(), 1);
});

test("the map is capped, oldest first", () => {
    const now = 1_000_000;
    for (let i = 0; i < MAX_TOKENS; i++) issue(`sess-${i}`, "tok", now + i);
    assert.equal(_size(), MAX_TOKENS);

    const { token: newest } = issue("sess-last", "tok", now + MAX_TOKENS);
    assert.equal(_size(), MAX_TOKENS, "cap holds");
    assert.ok(resolve(newest, now + MAX_TOKENS), "the new token survived");
});

test("revoking a session drops exactly its tokens", () => {
    const a1 = issue("sess-a", "tok").token;
    const a2 = issue("sess-a", "tok").token;
    const b1 = issue("sess-b", "tok").token;

    assert.equal(revokeForSession("sess-a"), 2);
    assert.equal(resolve(a1), null);
    assert.equal(resolve(a2), null);
    assert.ok(resolve(b1), "another session is untouched");
});

test("revoking an unknown session removes nothing", () => {
    issue("sess-a", "tok");
    assert.equal(revokeForSession("sess-zzz"), 0);
    assert.equal(_size(), 1);
});

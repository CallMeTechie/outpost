const test = require("node:test");
const assert = require("node:assert");
const cases = require("./fixtures/bookmarkPaths.json");
const { normalizeBookmarkPath, bookmarkPathHash } = require("../bookmarkPath");

test("normalization matches the shared fixture", () => {
    for (const { in: input, out } of cases) {
        assert.strictEqual(normalizeBookmarkPath(input), out, `input ${JSON.stringify(input)}`);
    }
});

test("the hash is stable, 64 hex characters, and distinguishes different paths", () => {
    const a = bookmarkPathHash("/volume1/docker");
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.strictEqual(a, bookmarkPathHash("/volume1/docker"));
    assert.notStrictEqual(a, bookmarkPathHash("/volume1/log"));
});

test("paths that normalize to the same value hash the same", () => {
    const a = bookmarkPathHash(normalizeBookmarkPath("/volume1/docker/"));
    const b = bookmarkPathHash(normalizeBookmarkPath("/volume1/docker/../docker"));
    assert.strictEqual(a, b);
});

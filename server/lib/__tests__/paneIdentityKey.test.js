const test = require("node:test");
const assert = require("node:assert");
const { paneIdentityKey } = require("../paneIdentityKey");

test("a stored identity keeps its own id", () => {
    assert.strictEqual(paneIdentityKey({ configuration: { identityId: 42 } }), 42);
});

test("ad-hoc credentials become 0, not null", () => {
    // This is the whole point of the function: session.configuration.identityId is null for a
    // directIdentity connection, and null in a unique index counts as distinct from every other
    // null - the index would stop biting and every connection would add another row.
    assert.strictEqual(paneIdentityKey({ configuration: { identityId: null } }), 0);
});

test("a missing configuration or a missing field is also 0", () => {
    assert.strictEqual(paneIdentityKey({ configuration: {} }), 0);
    assert.strictEqual(paneIdentityKey({}), 0);
    assert.strictEqual(paneIdentityKey(undefined), 0);
});

test("identity id 0 never comes from the database, so it cannot collide", () => {
    // identities.id is an autoIncrement primary key and both dialects start at 1.
    assert.strictEqual(paneIdentityKey({ configuration: { identityId: 1 } }), 1);
});

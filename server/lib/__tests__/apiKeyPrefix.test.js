const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

const keys = [];
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
fake("../../models/ApiKey", {
    count: async () => keys.length,
    create: async (row) => { const key = { id: keys.length + 1, ...row }; keys.push(key); return key; },
    findOne: async ({ where }) => keys.find((key) => key.tokenHash === where.tokenHash) ?? null,
    update: async () => {},
    destroy: async () => {},
});
fake("../../models/Account", { findByPk: async (id) => ({ id }) });

const { createApiKey, validateApiKey } = require("../../controllers/apiKey");

test("a new key carries the Outpost prefix and authenticates", async () => {
    const { token, prefix } = await createApiKey(7, { name: "claude" });
    assert.match(token, /^outpost_[0-9a-f]{64}$/);
    assert.ok(prefix.startsWith("outpost_"));
    assert.strictEqual((await validateApiKey(token)).account.id, 7);
});

test("a key issued under the Nexterm prefix still authenticates", async () => {
    const token = `nxt_${"a".repeat(64)}`;
    keys.push({ id: 99, accountId: 3, tokenHash: crypto.createHash("sha256").update(token).digest("hex"), expiresAt: null });
    assert.strictEqual((await validateApiKey(token)).account.id, 3);
});

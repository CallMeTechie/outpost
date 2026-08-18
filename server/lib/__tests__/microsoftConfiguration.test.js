process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const { createConfigurationProvider, MICROSOFT_ISSUER } = require("../microsoft/configuration");
const { sealClientSecret } = require("../microsoft/tokenCrypto");

const app = (overrides = {}) => ({
    id: 1,
    clientId: "app-id",
    redirectUri: "https://outpost.example/api/microsoft/callback",
    enabled: true,
    ...sealClientSecret("s3cr3t"),
    ...overrides,
});

const provider = ({ apps = [app()], discover } = {}) => {
    const calls = { discover: 0, load: 0 };
    const instance = createConfigurationProvider({
        loadActiveApp: async () => { calls.load += 1; return apps[0] ?? null; },
        discover: discover ?? (async (...args) => { calls.discover += 1; return { discovered: args }; }),
    });
    return { ...instance, calls };
};

test("the configuration is discovered from the multi-tenant issuer", async () => {
    const seen = [];
    const { getConfiguration } = provider({
        discover: async (issuer, clientId, clientSecret) => {
            seen.push({ issuer: issuer.href, clientId, clientSecret });
            return { ok: true };
        },
    });

    const result = await getConfiguration();

    assert.strictEqual(seen[0].issuer, `${MICROSOFT_ISSUER}`);
    assert.strictEqual(seen[0].clientId, "app-id");
    assert.strictEqual(seen[0].clientSecret, "s3cr3t", "the stored secret must be decrypted before use");
    assert.deepStrictEqual(result.configuration, { ok: true });
    assert.strictEqual(result.redirectUri, "https://outpost.example/api/microsoft/callback");
});

// Discovery is a network round trip. Doing it per token refresh would be absurd.
test("repeated calls reuse one discovery", async () => {
    const p = provider();

    await Promise.all([p.getConfiguration(), p.getConfiguration()]);
    await p.getConfiguration();

    assert.strictEqual(p.calls.discover, 1);
});

test("resetting forces the next call to rediscover", async () => {
    const p = provider();

    await p.getConfiguration();
    p.resetConfiguration();
    await p.getConfiguration();

    assert.strictEqual(p.calls.discover, 2);
});

test("no registration at all is a temporary failure, not a crash", async () => {
    const p = provider({ apps: [] });

    await assert.rejects(p.getConfiguration(), (error) => {
        assert.strictEqual(error.kind, "temporary");
        return true;
    });
});

test("a registration without a secret is a temporary failure", async () => {
    const p = provider({ apps: [app({ clientSecret: null, clientSecretIV: null, clientSecretAuthTag: null })] });

    await assert.rejects(p.getConfiguration(), (error) => error.kind === "temporary");
});

// A failed discovery must not be remembered as the answer, or a passing outage would be permanent.
test("a failed discovery is not cached", async () => {
    let attempt = 0;
    const p = provider({
        discover: async () => {
            attempt += 1;
            if (attempt === 1) throw new Error("network down");
            return { ok: true };
        },
    });

    await assert.rejects(p.getConfiguration());
    assert.deepStrictEqual((await p.getConfiguration()).configuration, { ok: true });
});

// The failure handler clears the cache. If it cleared it blindly it would also throw away a newer,
// successful configuration built after a reset.
test("a late failure does not clear a newer configuration", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let attempt = 0;

    const p = provider({
        discover: async () => {
            attempt += 1;
            if (attempt === 1) { await gate; throw new Error("slow failure"); }
            return { ok: attempt };
        },
    });

    const failing = p.getConfiguration();
    p.resetConfiguration();
    const fresh = await p.getConfiguration();

    release();
    await assert.rejects(failing);

    assert.strictEqual(attempt, 2, "the second call must have built its own configuration");
    assert.deepStrictEqual((await p.getConfiguration()).configuration, fresh.configuration,
        "the surviving cache must still be the successful one");
});

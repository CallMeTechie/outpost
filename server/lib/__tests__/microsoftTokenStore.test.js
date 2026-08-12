process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const { createTokenStore, REFRESH_BUFFER_MS } = require("../microsoft/tokenStore");
const { sealRefreshToken } = require("../microsoft/tokenCrypto");

const bodyError = (error, status = 400) =>
    Object.assign(new Error("oauth error"), { error, status, response: { headers: new Map() } });

const harness = ({ grant, connection, clock = { value: 1_000_000 } } = {}) => {
    const calls = { load: 0, grant: 0, persist: [], disconnected: [], logged: [] };
    // Not `connection ?? {...}`: `??` treats an explicitly passed `null` the same as "not
    // provided" and would silently substitute the default connected row, so the "missing
    // connection" test could never exercise loadConnection returning null.
    let row = connection === undefined ? {
        id: 1, status: "connected", ...sealRefreshToken("refresh-1"),
    } : connection;

    const store = createTokenStore({
        loadConnection: async () => { calls.load += 1; return row; },
        persistRefresh: async (id, token) => {
            calls.persist.push({ id, token });
            row = { ...row, ...sealRefreshToken(token) };
        },
        markDisconnected: async (id) => {
            calls.disconnected.push(id);
            row = { ...row, status: "disconnected", refreshToken: null };
        },
        getConfiguration: async () => ({ configuration: { fake: true } }),
        refreshTokenGrant: grant ?? (async () => {
            calls.grant += 1;
            return { access_token: `access-${calls.grant}`, refresh_token: `refresh-${calls.grant + 1}`, expires_in: 3600 };
        }),
        now: () => clock.value,
        log: (level, message, meta) => calls.logged.push({ level, message, meta }),
    });

    return { store, calls, clock, currentRow: () => row };
};

test("a first call refreshes and returns the access token", async () => {
    const { store, calls } = harness();

    assert.strictEqual(await store.getAccessToken(1), "access-1");
    assert.strictEqual(calls.grant, 1);
});

test("a second call inside the lifetime is served from memory", async () => {
    const { store, calls } = harness();

    await store.getAccessToken(1);
    await store.getAccessToken(1);

    assert.strictEqual(calls.grant, 1, "a cached token must not trigger a second refresh");
});

// The heart of the concurrency rule: Microsoft swaps the refresh token on every renewal, so a
// second parallel renewal would present a token that is already spent.
test("two concurrent callers share one refresh", async () => {
    const { store, calls } = harness();

    const [a, b] = await Promise.all([store.getAccessToken(1), store.getAccessToken(1)]);

    assert.strictEqual(calls.grant, 1, "exactly one refresh may be in flight per connection");
    assert.strictEqual(a, b);
});

test("a failed refresh does not leave the connection wedged", async () => {
    let attempt = 0;
    const { store } = harness({
        grant: async () => {
            attempt += 1;
            if (attempt === 1) throw new TypeError("fetch failed");
            return { access_token: "access-late", refresh_token: "refresh-2", expires_in: 3600 };
        },
    });

    await assert.rejects(store.getAccessToken(1));
    assert.strictEqual(await store.getAccessToken(1), "access-late",
        "the in-flight slot must be released even when the refresh threw");
});

// Forgetting this is the failure that stays invisible until the next restart.
test("the rotated refresh token is persisted", async () => {
    const { store, calls } = harness();

    await store.getAccessToken(1);

    assert.deepStrictEqual(calls.persist, [{ id: 1, token: "refresh-2" }]);
});

test("a response without a new refresh token keeps the old one", async () => {
    const { store, calls } = harness({
        grant: async () => ({ access_token: "access-1", expires_in: 3600 }),
    });

    await store.getAccessToken(1);

    assert.deepStrictEqual(calls.persist, [{ id: 1, token: "refresh-1" }]);
});

test("a token about to expire is renewed before it is handed out", async () => {
    const { store, calls, clock } = harness();

    await store.getAccessToken(1);
    clock.value += 3600 * 1000 - REFRESH_BUFFER_MS + 1;
    await store.getAccessToken(1);

    assert.strictEqual(calls.grant, 2, "the five minute buffer must force an early renewal");
});

test("a token well inside the buffer is not renewed", async () => {
    const { store, calls, clock } = harness();

    await store.getAccessToken(1);
    clock.value += 3600 * 1000 - REFRESH_BUFFER_MS - 60_000;
    await store.getAccessToken(1);

    assert.strictEqual(calls.grant, 1);
});

test("invalid_grant disconnects the connection and drops the token", async () => {
    const { store, calls, currentRow } = harness({ grant: async () => { throw bodyError("invalid_grant"); } });

    await assert.rejects(store.getAccessToken(1), (error) => error.kind === "disconnected");

    assert.deepStrictEqual(calls.disconnected, [1]);
    assert.strictEqual(currentRow().status, "disconnected");
});

test("a network failure leaves the connection connected", async () => {
    const { store, calls, currentRow } = harness({ grant: async () => { throw new TypeError("fetch failed"); } });

    await assert.rejects(store.getAccessToken(1), (error) => error.kind === "temporary");

    assert.deepStrictEqual(calls.disconnected, []);
    assert.strictEqual(currentRow().status, "connected");
});

test("invalid_client leaves every connection alone but is logged as an error", async () => {
    const { store, calls, currentRow } = harness({ grant: async () => { throw bodyError("invalid_client", 401); } });

    await assert.rejects(store.getAccessToken(1), (error) => error.kind === "temporary");

    assert.deepStrictEqual(calls.disconnected, []);
    assert.strictEqual(currentRow().status, "connected");
    assert.ok(calls.logged.some(l => l.level === "error" && /client secret/i.test(l.message)),
        "an administrator has to be able to see this in the server log");
});

test("a rate limit passes Retry-After to the caller", async () => {
    const error429 = Object.assign(new Error("too many"), {
        cause: { status: 429, headers: new Map([["retry-after", "12"]]) },
    });
    const { store } = harness({ grant: async () => { throw error429; } });

    await assert.rejects(store.getAccessToken(1), (error) => {
        assert.strictEqual(error.kind, "temporary");
        assert.strictEqual(error.retryAfter, 12);
        return true;
    });
});

test("a disconnected connection fails without asking Microsoft", async () => {
    const { store, calls } = harness({
        connection: { id: 1, status: "disconnected", refreshToken: null },
    });

    await assert.rejects(store.getAccessToken(1), (error) => error.kind === "disconnected");
    assert.strictEqual(calls.grant, 0);
});

test("a missing connection fails as disconnected", async () => {
    const { store } = harness({ connection: null });

    await assert.rejects(store.getAccessToken(1), (error) => error.kind === "disconnected");
});

// Disabling the app registration must reach running connections, not only new sign-ins.
test("a disabled registration fails temporarily and never renews", async () => {
    const calls = { grant: 0 };
    const store = createTokenStore({
        loadConnection: async () => ({ id: 1, status: "connected", ...sealRefreshToken("refresh-1") }),
        persistRefresh: async () => {},
        markDisconnected: async () => { throw new Error("must not disconnect"); },
        getConfiguration: async () => { throw Object.assign(new Error("disabled"), { kind: "temporary" }); },
        refreshTokenGrant: async () => { calls.grant += 1; return {}; },
        now: () => 1_000_000,
        log: () => {},
    });

    await assert.rejects(store.getAccessToken(1), (error) => error.kind === "temporary");
    assert.strictEqual(calls.grant, 0);
});

test("forget drops the cached token so the next call renews", async () => {
    const { store, calls } = harness();

    await store.getAccessToken(1);
    store.forget(1);
    await store.getAccessToken(1);

    assert.strictEqual(calls.grant, 2);
});

// The cache must never hold a token whose rotated refresh token failed to reach the database: the
// old one is already spent at Microsoft, so a cached access token would paper over a dead connection.
test("a failed persist is not papered over by the cache", async () => {
    const calls = { grant: 0 };
    const store = createTokenStore({
        loadConnection: async () => ({ id: 1, status: "connected", ...sealRefreshToken("refresh-1") }),
        persistRefresh: async () => { throw new Error("database gone"); },
        markDisconnected: async () => { throw new Error("must not disconnect"); },
        getConfiguration: async () => ({ configuration: { fake: true } }),
        refreshTokenGrant: async () => {
            calls.grant += 1;
            return { access_token: "access-1", refresh_token: "refresh-2", expires_in: 3600 };
        },
        now: () => 1_000_000,
        log: () => {},
    });

    await assert.rejects(store.getAccessToken(1));
    await assert.rejects(store.getAccessToken(1));

    assert.strictEqual(calls.grant, 2, "a token that was never persisted must not be served from the cache");
});

// Deliberate, and pinned so it cannot drift: a cached token is served without consulting the
// configuration at all. Disabling the integration stops *renewals* — it does not reach back and
// revoke a token that is already in hand and still valid.
test("a cached token is served without consulting the configuration", async () => {
    let configCalls = 0;
    const store = createTokenStore({
        loadConnection: async () => ({ id: 1, status: "connected", ...sealRefreshToken("refresh-1") }),
        persistRefresh: async () => {},
        markDisconnected: async () => {},
        getConfiguration: async () => { configCalls += 1; return { configuration: { fake: true } }; },
        refreshTokenGrant: async () => ({ access_token: "access-1", refresh_token: "refresh-2", expires_in: 3600 }),
        now: () => 1_000_000,
        log: () => {},
    });

    await store.getAccessToken(1);
    await store.getAccessToken(1);

    assert.strictEqual(configCalls, 1, "a cache hit must not cost a configuration lookup");
});

// A grant that parks until it is released, so a renewal can be observed while it is in flight.
const gatedHarness = () => {
    const releases = [];
    const state = { grants: 0 };

    const { store, calls } = harness({
        grant: async () => {
            state.grants += 1;
            const attempt = state.grants;
            await new Promise(resolve => releases.push(resolve));
            return { access_token: `access-${attempt}`, refresh_token: `refresh-${attempt + 1}`, expires_in: 3600 };
        },
    });

    return { store, calls, releases, state };
};

const tick = () => new Promise(resolve => setImmediate(resolve));

// forget() used to drop the cached token only. A renewal that was already running then finished,
// found nothing in its way, and filled the cache back in — so a connection that had just been
// deleted kept handing out access tokens.
test("a connection forgotten while a renewal is running does not get its token back", async () => {
    const { store, calls, releases, state } = gatedHarness();

    const running = store.getAccessToken(1);
    await tick();

    store.forget(1);

    releases[0]();
    assert.strictEqual(await running, "access-1", "the caller that started the renewal still gets its token");
    assert.deepStrictEqual(calls.persist, [{ id: 1, token: "refresh-2" }],
        "the rotated refresh token must still be persisted — Microsoft has already spent the old one");

    const next = store.getAccessToken(1);
    await tick();

    assert.strictEqual(state.grants, 2, "the forgotten renewal must not have left a usable token in the cache");

    releases[1]();
    assert.strictEqual(await next, "access-2");
});

// The identity check in renew: only the renewal that is still the current in-flight one may write
// the cache. Without it, a renewal that was forgotten mid-flight finishes late and overwrites the
// token that the reconnect stored in the meantime with one whose refresh token is already spent.
test("a late renewal does not overwrite the token of the renewal that replaced it", async () => {
    const { store, releases, state } = gatedHarness();

    const abandoned = store.getAccessToken(1);
    await tick();

    // What a reconnect does: upsertConnection stores a fresh refresh token and calls forget.
    store.forget(1);

    const replacement = store.getAccessToken(1);
    await tick();

    assert.strictEqual(state.grants, 2, "forget must release the in-flight slot, not only the cache slot");

    releases[1]();
    assert.strictEqual(await replacement, "access-2");

    releases[0]();
    assert.strictEqual(await abandoned, "access-1");

    assert.strictEqual(await store.getAccessToken(1), "access-2",
        "the abandoned renewal must not put its stale token back over the current one");
});

// Disabling the registration clears the configuration cache — which getAccessToken never reaches on
// a cache hit. Without forgetAll the disabled integration would keep serving tokens for an hour.
test("forgetAll drops every cached token", async () => {
    const { store, calls } = harness();

    await store.getAccessToken(1);
    await store.getAccessToken(2);
    assert.strictEqual(calls.grant, 2);

    store.forgetAll();

    await store.getAccessToken(1);
    await store.getAccessToken(2);

    assert.strictEqual(calls.grant, 4, "every connection must renew again after the registration changed");
});

test("two connections do not share a cache slot", async () => {
    const { store, calls } = harness();

    await store.getAccessToken(1);
    await store.getAccessToken(2);

    assert.strictEqual(calls.grant, 2);
});

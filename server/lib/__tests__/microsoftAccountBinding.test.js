process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const { handleCallback } = require("../../controllers/microsoftAuth");
const { createState } = require("../microsoft/authState");

// The account a connection is filed under comes from the stored state entry and from nowhere else.
// The callback request carries no session, so anything the query says about an account is an
// attacker's claim. authState pins that the entry keeps the account; these tests pin the seam where
// the entry is spent — the line `accountId: entry.accountId` in handleCallback. Replacing it with a
// fixed foreign id passes every other test in this repository.

const OWNER_ACCOUNT_ID = 7;
const ATTACKER_ACCOUNT_ID = 99;

// A state entry as startConnect would have created it, through the real createState.
const stateFor = (accountId = OWNER_ACCOUNT_ID) => createState({
    accountId,
    codeVerifier: "verifier-abcdefghijklmnopqrstuvwxyz012345",
    nonce: "nonce-1234567890",
    scope: "openid profile email offline_access Files.ReadWrite",
});

const fakes = ({ claims = { oid: "ms-account-oid" } } = {}) => {
    const upserted = [];
    const exchanged = [];

    return {
        upserted,
        exchanged,
        deps: {
            loadConfiguration: async () => ({
                configuration: { fake: true },
                redirectUri: "https://nexterm.example/api/microsoft/callback",
            }),
            exchange: async (configuration, currentUrl, options) => {
                exchanged.push({ currentUrl: currentUrl.href, options });
                return {
                    access_token: "access-1",
                    refresh_token: "refresh-1",
                    scope: "openid profile email offline_access Files.ReadWrite",
                    claims: () => claims,
                };
            },
            upsert: async (connection) => { upserted.push(connection); return 1; },
        },
    };
};

test("the connection is filed under the account the state entry carries", async () => {
    const { deps, upserted } = fakes();
    const state = stateFor(OWNER_ACCOUNT_ID);

    const result = await handleCallback({ code: "auth-code", state }, deps);

    assert.deepStrictEqual(result, { status: "connected" });
    assert.strictEqual(upserted.length, 1);
    assert.strictEqual(upserted[0].accountId, OWNER_ACCOUNT_ID,
        "the account must come from the stored state entry, never from a constant or the request");
});

test("a hostile account field in the callback query is ignored", async () => {
    for (const hostile of [
        { accountId: ATTACKER_ACCOUNT_ID },
        { account_id: ATTACKER_ACCOUNT_ID },
        { sub: ATTACKER_ACCOUNT_ID },
        { accountId: ATTACKER_ACCOUNT_ID, account_id: ATTACKER_ACCOUNT_ID, sub: ATTACKER_ACCOUNT_ID },
    ]) {
        const { deps, upserted } = fakes();
        const state = stateFor(OWNER_ACCOUNT_ID);

        const result = await handleCallback({ code: "auth-code", state, ...hostile }, deps);

        assert.deepStrictEqual(result, { status: "connected" });
        assert.strictEqual(upserted[0].accountId, OWNER_ACCOUNT_ID,
            `${JSON.stringify(hostile)} in the query must not move the connection to another account`);
    }
});

// Two different accounts, run through the same code path: a binding that ignores the entry and uses
// a constant would give both the same answer.
test("two sign-ins land on their own accounts", async () => {
    const first = fakes();
    const second = fakes();

    await handleCallback({ code: "auth-code", state: stateFor(OWNER_ACCOUNT_ID) }, first.deps);
    await handleCallback({ code: "auth-code", state: stateFor(ATTACKER_ACCOUNT_ID) }, second.deps);

    assert.strictEqual(first.upserted[0].accountId, OWNER_ACCOUNT_ID);
    assert.strictEqual(second.upserted[0].accountId, ATTACKER_ACCOUNT_ID);
    assert.notStrictEqual(first.upserted[0].accountId, second.upserted[0].accountId);
});

// A state is single use. Replaying one — the shape of an attempt to graft a captured code onto a
// second connection — must stop before anything is written.
test("a state that was already consumed never reaches the upsert", async () => {
    const state = stateFor(OWNER_ACCOUNT_ID);

    const firstRun = fakes();
    assert.deepStrictEqual(await handleCallback({ code: "auth-code", state }, firstRun.deps),
        { status: "connected" });

    const replay = fakes();
    const result = await handleCallback({ code: "auth-code", state }, replay.deps);

    assert.deepStrictEqual(result, { status: "error", reason: "state_invalid" });
    assert.deepStrictEqual(replay.upserted, [], "a replayed state must not write a connection");
    assert.deepStrictEqual(replay.exchanged, [], "a replayed state must not even be exchanged");
});

test("an unknown state never reaches the upsert", async () => {
    const { deps, upserted, exchanged } = fakes();

    const result = await handleCallback({ code: "auth-code", state: "not-a-state-we-issued" }, deps);

    assert.deepStrictEqual(result, { status: "error", reason: "state_invalid" });
    assert.deepStrictEqual(upserted, []);
    assert.deepStrictEqual(exchanged, []);
});

// The exchange is pinned to the entry as well: the PKCE verifier and nonce that were stored with
// the account are the ones presented to Microsoft.
test("the exchange presents the verifier and nonce from the same entry", async () => {
    const { deps, exchanged } = fakes();
    const state = stateFor(OWNER_ACCOUNT_ID);

    await handleCallback({ code: "auth-code", state }, deps);

    assert.strictEqual(exchanged.length, 1);
    assert.strictEqual(exchanged[0].options.expectedState, state);
    assert.strictEqual(exchanged[0].options.pkceCodeVerifier, "verifier-abcdefghijklmnopqrstuvwxyz012345");
    assert.strictEqual(exchanged[0].options.expectedNonce, "nonce-1234567890");
});

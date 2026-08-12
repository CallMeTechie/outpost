process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const {
    sealRefreshToken, openRefreshToken, sealClientSecret, openClientSecret, MASKED_SECRET,
} = require("../microsoft/tokenCrypto");

const PLAINTEXT = "0.AXkAmicrosoft-refresh-token-value";

test("a sealed refresh token round-trips", () => {
    assert.strictEqual(openRefreshToken(sealRefreshToken(PLAINTEXT)), PLAINTEXT);
});

// The single promise of this module: whatever reaches the database is not the token.
test("nothing readable survives in the sealed fields", () => {
    const sealed = sealRefreshToken(PLAINTEXT);

    for (const [field, value] of Object.entries(sealed)) {
        assert.notStrictEqual(value, PLAINTEXT, `${field} holds the plaintext`);
        assert.ok(!String(value).includes("refresh-token-value"), `${field} leaks part of the plaintext`);
    }
});

test("sealing the same value twice produces different ciphertext", () => {
    const a = sealRefreshToken(PLAINTEXT);
    const b = sealRefreshToken(PLAINTEXT);

    assert.notStrictEqual(a.refreshTokenIV, b.refreshTokenIV, "the IV must not be reused");
    assert.notStrictEqual(a.refreshToken, b.refreshToken);
});

test("opening a row without a token yields null instead of throwing", () => {
    for (const row of [null, undefined, {}, { refreshToken: null }]) {
        assert.strictEqual(openRefreshToken(row), null, `failed for ${JSON.stringify(row)}`);
    }
});

// A wrong auth tag means the row was tampered with or the key changed. Neither may take the
// process down: getAccessToken has to be able to report a dead connection.
test("a tampered row opens as null instead of throwing", () => {
    const sealed = sealRefreshToken(PLAINTEXT);
    sealed.refreshTokenAuthTag = "00".repeat(16);

    assert.strictEqual(openRefreshToken(sealed), null);
});

test("an incomplete row opens as null instead of throwing", () => {
    const sealed = sealRefreshToken(PLAINTEXT);
    delete sealed.refreshTokenIV;

    assert.strictEqual(openRefreshToken(sealed), null);
});

test("the client secret uses its own field names", () => {
    const sealed = sealClientSecret("s3cr3t");

    assert.deepStrictEqual(Object.keys(sealed).sort(),
        ["clientSecret", "clientSecretAuthTag", "clientSecretIV"]);
    assert.strictEqual(openClientSecret(sealed), "s3cr3t");
});

test("the mask is the constant the API hands out instead of the secret", () => {
    assert.strictEqual(MASKED_SECRET, "********");
});

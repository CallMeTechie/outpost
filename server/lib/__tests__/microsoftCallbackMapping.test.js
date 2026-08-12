const test = require("node:test");
const assert = require("node:assert");
const { mapAuthorizeError } = require("../../controllers/microsoftAuth");
const { CALLBACK_REASONS } = require("../microsoft/callbackPage");

test("every mapped reason is one the callback page knows", () => {
    const queries = [
        { error: "consent_required" },
        { error: "access_denied", error_description: "AADSTS65001: The user or administrator has not consented" },
        { error: "access_denied", error_description: "AADSTS90094: An administrator of the tenant must grant consent" },
        { error: "access_denied", error_description: "user cancelled" },
        { error: "server_error" },
        {},
    ];

    for (const query of queries) {
        const reason = mapAuthorizeError(query);
        assert.ok(CALLBACK_REASONS.has(reason), `${reason} is not a reason the page can render`);
    }
});

// The tenant-consent case is the one the spec promises to name in plain words.
test("a tenant that requires admin consent is named as such", () => {
    assert.strictEqual(mapAuthorizeError({ error: "consent_required" }), "consent_required");

    for (const code of ["AADSTS65001", "AADSTS90094"]) {
        assert.strictEqual(
            mapAuthorizeError({ error: "access_denied", error_description: `${code}: consent needed` }),
            "consent_required",
            `${code} must be recognised even behind access_denied`);
    }
});

test("a user who simply cancelled is not blamed on the tenant", () => {
    assert.strictEqual(mapAuthorizeError({ error: "access_denied", error_description: "user cancelled" }),
        "access_denied");
});

test("anything else falls back to the generic reason", () => {
    assert.strictEqual(mapAuthorizeError({ error: "server_error" }), "authorize_failed");
    assert.strictEqual(mapAuthorizeError({}), "authorize_failed");
});

test("a non-string description does not take the mapping down", () => {
    for (const description of [null, 42, {}, undefined]) {
        assert.strictEqual(mapAuthorizeError({ error: "access_denied", error_description: description }),
            "access_denied", `failed for ${JSON.stringify(description)}`);
    }
});

import { test } from "node:test";
import assert from "node:assert/strict";

const values = new Map();
globalThis.window = {
    sessionStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
    },
};

const { markExplicitLogout, createAutoLoginSuppressionGuard } = await import("../OIDCLogoutUtil.js");

test("an explicit logout suppresses OIDC auto-login for exactly one opening of the login dialog", () => {
    markExplicitLogout();
    const shouldSkip = createAutoLoginSuppressionGuard();

    assert.equal(shouldSkip(true), true);
    assert.equal(shouldSkip(true), true, "StrictMode's second effect run must see the same decision");

    shouldSkip(false);
    assert.equal(shouldSkip(true), false);
});

const test = require("node:test");
const assert = require("node:assert");
const { IdentityAccessDeniedError } = require("../ConnectionService");

test("the error type exists and is an Error", () => {
    const err = new IdentityAccessDeniedError();
    assert.ok(err instanceof Error);
    assert.match(err.message, /identity/i);
});

test("the error is distinguishable from a plain Error", () => {
    assert.strictEqual(new Error("x") instanceof IdentityAccessDeniedError, false);
});

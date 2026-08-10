const test = require("node:test");
const assert = require("node:assert");

// First, import the unmocked IdentityAccessDeniedError for the basic tests
const { IdentityAccessDeniedError } = require("../ConnectionService");

test("the error type exists and is an Error", () => {
    const err = new IdentityAccessDeniedError();
    assert.ok(err instanceof Error);
    assert.match(err.message, /identity/i);
});

test("the error is distinguishable from a plain Error", () => {
    assert.strictEqual(new Error("x") instanceof IdentityAccessDeniedError, false);
});

// Guard test: Set up mock BEFORE test runs, to catch the guard in action
test("guard intercepts accessDenied and throws by name, not TypeError", async () => {
    // Mock resolveIdentity in-place before calling resolveFileTransferContext
    const identityResolverPath = require.resolve("../../utils/identityResolver");
    const originalModule = require.cache[identityResolverPath];

    const mockResolveIdentity = async () => ({
        identity: null,
        accessDenied: true,
    });

    // Replace the cached module
    require.cache[identityResolverPath] = {
        exports: { resolveIdentity: mockResolveIdentity },
    };

    // Now load a fresh instance of ConnectionService that will use the mocked resolveIdentity
    // Clear the cache first to force a clean require
    delete require.cache[require.resolve("../ConnectionService")];

    try {
        // Import the fresh ConnectionService with mocked dependency
        const freshCS = require("../ConnectionService");
        const resolveFileTransferContextFn = freshCS.resolveFileTransferContext;

        // Attempt to call it - should hit the guard and throw IdentityAccessDeniedError
        let caughtError = null;
        try {
            await resolveFileTransferContextFn({ protocol: "sftp" }, "test-id", null, "acc-1");
        } catch (e) {
            caughtError = e;
        }

        // Verify: error exists, is not TypeError, and is the right custom error
        assert.ok(caughtError, "should throw an error when accessDenied is true");
        assert.strictEqual(caughtError.name, "IdentityAccessDeniedError", "error name should be IdentityAccessDeniedError");
        assert.match(caughtError.message, /identity/i, "error message should mention identity");
        assert.ok(!(caughtError instanceof TypeError), "should not throw TypeError (this was the bug)");
    } finally {
        // Restore original module
        if (originalModule) {
            require.cache[identityResolverPath] = originalModule;
        } else {
            delete require.cache[identityResolverPath];
        }
        delete require.cache[require.resolve("../ConnectionService")];
        // Re-require to restore normal state for other tests
        require("../ConnectionService");
    }
});

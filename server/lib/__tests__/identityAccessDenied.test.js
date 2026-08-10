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

// Guard test: through public getSessionPassword API
test("guard intercepts accessDenied and throws by name, not TypeError", async () => {
    // Mock resolveIdentity before reloading ConnectionService
    const identityResolverPath = require.resolve("../../utils/identityResolver");
    const originalResolverModule = require.cache[identityResolverPath];

    const mockResolveIdentity = async () => ({
        identity: null,
        accessDenied: true,
    });

    require.cache[identityResolverPath] = {
        exports: { resolveIdentity: mockResolveIdentity },
    };

    // Clear only ConnectionService cache (SessionManager stays the same)
    const connectionServicePath = require.resolve("../ConnectionService");
    delete require.cache[connectionServicePath];

    try {
        // Import ConnectionService fresh with mocked resolveIdentity
        const { getSessionPassword } = require("../ConnectionService");
        const SessionManager = require("../SessionManager");

        // Create a minimal session and extract the sessionId
        const session = SessionManager.create(
            "acc-1",
            "entry-1",
            { identityId: "test-id", directIdentity: null },
        );
        const sessionId = session.sessionId;

        // Call getSessionPassword which internally calls resolveFileTransferContext
        // Should hit the guard and throw IdentityAccessDeniedError
        let caughtError = null;
        try {
            await getSessionPassword(sessionId, { protocol: "sftp" }, "acc-1");
        } catch (e) {
            caughtError = e;
        }

        // Verify: error is IdentityAccessDeniedError, not TypeError
        assert.ok(caughtError, "should throw an error when accessDenied is true");
        assert.strictEqual(caughtError.name, "IdentityAccessDeniedError", "error name should be IdentityAccessDeniedError");
        assert.match(caughtError.message, /identity/i, "error message should mention identity");
        assert.ok(!(caughtError instanceof TypeError), "should not throw TypeError (this was the bug)");
    } finally {
        // Restore original identityResolver
        if (originalResolverModule) {
            require.cache[identityResolverPath] = originalResolverModule;
        } else {
            delete require.cache[identityResolverPath];
        }
        // Re-require ConnectionService to restore normal state
        delete require.cache[connectionServicePath];
        require("../ConnectionService");
    }
});

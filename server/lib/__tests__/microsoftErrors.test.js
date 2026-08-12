const test = require("node:test");
const assert = require("node:assert");
const {
    classifyTokenError, MicrosoftDisconnectedError, MicrosoftTemporaryError,
} = require("../microsoft/errors");

// openid-client throws oauth4webapi's ResponseBodyError for an OAuth-style error body: it carries
// `error`, `status` and `response`.
const bodyError = (error, status = 400, headers = new Map()) =>
    Object.assign(new Error("server responded with an error in the response body"),
        { error, status, response: { headers } });

// For a status without an OAuth body it throws OperationProcessingError, whose `cause` is the
// Response itself.
const processingError = (status, headers = new Map()) =>
    Object.assign(new Error("response is not conform"), { cause: { status, headers } });

test("invalid_grant is the only final verdict", () => {
    const verdict = classifyTokenError(bodyError("invalid_grant"));

    assert.strictEqual(verdict.kind, "final");
    assert.strictEqual(verdict.reason, "invalid_grant");
});

test("a network failure leaves the connection alone", () => {
    const verdict = classifyTokenError(new TypeError("fetch failed"));

    assert.strictEqual(verdict.kind, "transient");
    assert.strictEqual(verdict.reason, "network_error");
});

test("a server error leaves the connection alone", () => {
    for (const status of [500, 502, 503]) {
        assert.strictEqual(classifyTokenError(processingError(status)).kind, "transient",
            `HTTP ${status} must not disconnect`);
    }
});

test("invalid_client is transient and names itself so an admin can be told", () => {
    const verdict = classifyTokenError(bodyError("invalid_client", 401));

    assert.strictEqual(verdict.kind, "transient");
    assert.strictEqual(verdict.reason, "invalid_client",
        "the caller decides to log this loudly — it must stay distinguishable");
});

test("a rate limit is transient and passes Retry-After through", () => {
    const verdict = classifyTokenError(processingError(429, new Map([["retry-after", "42"]])));

    assert.strictEqual(verdict.kind, "transient");
    assert.strictEqual(verdict.reason, "rate_limited");
    assert.strictEqual(verdict.retryAfter, 42);
});

// Microsoft may answer 429 with an OAuth body. The rate limit still governs.
test("a rate limit with an OAuth body is still a rate limit", () => {
    const verdict = classifyTokenError(bodyError("temporarily_unavailable", 429, new Map([["retry-after", "7"]])));

    assert.strictEqual(verdict.reason, "rate_limited");
    assert.strictEqual(verdict.retryAfter, 7);
});

// The ordering rule, checked against the one error that has a branch of its own further down.
test("a rate limit that carries invalid_client is still a rate limit", () => {
    const verdict = classifyTokenError(bodyError("invalid_client", 429, new Map([["retry-after", "3"]])));

    assert.strictEqual(verdict.reason, "rate_limited");
    assert.strictEqual(verdict.retryAfter, 3);
});

// oauth4webapi raises this before parsing any OAuth body; it carries no `error` field, so without a
// branch of its own it would fall through to "network_error" and the admin log would never fire.
test("a WWW-Authenticate challenge is reported as invalid_client, not as a network error", () => {
    const challenge = Object.assign(new Error("server responded with a challenge"), {
        code: "OAUTH_WWW_AUTHENTICATE_CHALLENGE", status: 401, response: { headers: new Map() },
    });

    const verdict = classifyTokenError(challenge);

    assert.strictEqual(verdict.kind, "transient");
    assert.strictEqual(verdict.reason, "invalid_client");
});

test("an unparsable Retry-After becomes null instead of NaN", () => {
    for (const value of ["Wed, 21 Oct 2026 07:28:00 GMT", "", "soon"]) {
        const verdict = classifyTokenError(processingError(429, new Map([["retry-after", value]])));
        assert.strictEqual(verdict.retryAfter, null, `failed for ${JSON.stringify(value)}`);
    }
});

// Anything Microsoft invents later must not silently disconnect every user.
test("an unknown OAuth error defaults to transient", () => {
    const verdict = classifyTokenError(bodyError("something_new_from_microsoft"));

    assert.strictEqual(verdict.kind, "transient");
    assert.strictEqual(verdict.reason, "something_new_from_microsoft");
});

test("a thrown non-error does not take the classifier down", () => {
    for (const value of [null, undefined, "boom", 42]) {
        assert.strictEqual(classifyTokenError(value).kind, "transient", `failed for ${JSON.stringify(value)}`);
    }
});

test("the two error classes are distinguishable by kind", () => {
    assert.strictEqual(new MicrosoftDisconnectedError("x").kind, "disconnected");
    assert.strictEqual(new MicrosoftTemporaryError("x").kind, "temporary");
    assert.strictEqual(new MicrosoftTemporaryError("x", { retryAfter: 5 }).retryAfter, 5);
    assert.strictEqual(new MicrosoftTemporaryError("x").retryAfter, null);
});

test("both error classes are real Errors with usable names", () => {
    assert.ok(new MicrosoftDisconnectedError("x") instanceof Error);
    assert.strictEqual(new MicrosoftDisconnectedError("x").name, "MicrosoftDisconnectedError");
    assert.strictEqual(new MicrosoftTemporaryError("x").name, "MicrosoftTemporaryError");
});

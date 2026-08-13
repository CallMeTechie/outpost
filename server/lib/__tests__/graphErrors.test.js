const test = require("node:test");
const assert = require("node:assert");
const {
    GraphError, describeGraphFailure, isPermanentFailure, readGraphCode, readRetryAfter,
} = require("../microsoft/graphErrors");

const body = (code) => ({ error: { code, message: "whatever Microsoft says" } });

test("a full drive is named as such, not as a generic failure", () => {
    const message = describeGraphFailure(507, null);

    assert.match(message, /full/i);
    assert.doesNotMatch(message, /failed/i, "the user must read what is wrong, not that something is");
});

// Microsoft does not always use 507 for a full drive; the body's own code decides too.
test("a quota code counts as full whatever the status says", () => {
    assert.match(describeGraphFailure(400, body("quotaLimitReached")), /full/i);
});

// The retry decision and the sentence the user reads have to come from one rule. While they were
// two, a 500 carrying quotaLimitReached was retried five times and then reported as a full drive.
test("a permanent failure is named the same way whatever status carries it", () => {
    assert.strictEqual(isPermanentFailure(507, null), true);
    assert.strictEqual(isPermanentFailure(500, body("quotaLimitReached")), true);
    assert.strictEqual(isPermanentFailure(429, body("quotaLimitReached")), true);

    assert.strictEqual(isPermanentFailure(500, null), false);
    assert.strictEqual(isPermanentFailure(429, body("activityLimitReached")), false);
    assert.strictEqual(isPermanentFailure(500, { error: { code: 7 } }), false);
});

test("the everyday failures each get their own words", () => {
    assert.match(describeGraphFailure(403, null), /access/i);
    assert.match(describeGraphFailure(404, null), /exist/i);
    assert.match(describeGraphFailure(409, null), /already exists/i);
    assert.match(describeGraphFailure(429, null), /throttl/i);
});

test("a server error reads as temporary", () => {
    for (const status of [500, 502, 503]) {
        assert.match(describeGraphFailure(status, null), /temporarily/i, `failed for ${status}`);
    }
});

test("an unknown status still names its number", () => {
    assert.match(describeGraphFailure(418, null), /418/);
});

test("a malformed body never takes the translation down", () => {
    for (const value of [null, undefined, "", 42, {}, { error: "not an object" }, { error: {} }]) {
        assert.strictEqual(typeof describeGraphFailure(500, value), "string", `failed for ${JSON.stringify(value)}`);
    }
});

test("Retry-After is read only when it is a whole number of seconds", () => {
    const headers = (value) => new Map(value === null ? [] : [["retry-after", value]]);

    assert.strictEqual(readRetryAfter(headers("30")), 30);
    assert.strictEqual(readRetryAfter(headers("0")), 0);
    assert.strictEqual(readRetryAfter(headers(null)), null);
});

// An HTTP-date is a legal Retry-After and parseInt would turn "Wed, 21 Oct..." into NaN, or worse
// into 21. Anything that is not a plain count of seconds is treated as absent.
test("an unparsable Retry-After is treated as absent, never as a number", () => {
    const headers = (value) => new Map([["retry-after", value]]);

    for (const value of ["Wed, 21 Oct 2026 07:28:00 GMT", "", "soon", "-5"]) {
        assert.strictEqual(readRetryAfter(headers(value)), null, `failed for ${JSON.stringify(value)}`);
    }
    assert.strictEqual(readRetryAfter(undefined), null);
});

test("readGraphCode only trusts a string", () => {
    assert.strictEqual(readGraphCode(body("itemNotFound")), "itemNotFound");
    assert.strictEqual(readGraphCode({ error: { code: 7 } }), null);
    assert.strictEqual(readGraphCode(null), null);
});

test("GraphError is a real Error and carries what the caller has to branch on", () => {
    const error = new GraphError("boom", { status: 429, code: "activityLimitReached", retryAfter: 12 });

    assert.ok(error instanceof Error);
    assert.strictEqual(error.name, "GraphError");
    assert.strictEqual(error.status, 429);
    assert.strictEqual(error.code, "activityLimitReached");
    assert.strictEqual(error.retryAfter, 12);
});

test("GraphError without details leaves its fields null rather than undefined", () => {
    const error = new GraphError("boom");

    assert.strictEqual(error.status, null);
    assert.strictEqual(error.code, null);
    assert.strictEqual(error.retryAfter, null);
});

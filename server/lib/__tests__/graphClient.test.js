const test = require("node:test");
const assert = require("node:assert");
const {
    createGraphClient, backoffDelay, GRAPH_BASE, GRAPH_ORIGIN, MAX_ATTEMPTS, MAX_WAIT_MS, MAX_TOTAL_WAIT_MS,
} = require("../microsoft/graphClient");

const reply = (status, body = null, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    json: async () => {
        if (body === null) throw new Error("no body");
        return body;
    },
});

const harness = (responses, { token = "tok" } = {}) => {
    const calls = { fetches: [], slept: [], tokens: 0, forgotten: [] };
    const queue = [...responses];

    const client = createGraphClient({
        getAccessToken: async () => { calls.tokens += 1; return token; },
        forgetToken: (id) => calls.forgotten.push(id),
        fetchImpl: async (url, options) => {
            calls.fetches.push({ url, options });
            const next = queue.shift();
            if (typeof next === "function") return next();
            return next;
        },
        sleep: async (ms) => { calls.slept.push(ms); },
        // 0.5 lands exactly in the middle of the spread, so the jitter contributes nothing and the
        // delays are checkable numbers.
        random: () => 0.5,
    });

    return { client, calls };
};

test("a plain request returns the parsed body and carries the token", async () => {
    const { client, calls } = harness([reply(200, { value: [] })]);

    const result = await client.request(1, { url: "/root/children" });

    assert.deepStrictEqual(result.body, { value: [] });
    assert.strictEqual(calls.fetches[0].url, `${GRAPH_BASE}/root/children`);
    assert.strictEqual(calls.fetches[0].options.headers.Authorization, "Bearer tok");
});

test("an absolute url is used as given, not appended to the base", async () => {
    const { client, calls } = harness([reply(200, {})]);

    const next = `${GRAPH_ORIGIN}/v1.0/me/drive/root/children?$skiptoken=abc`;
    await client.request(1, { url: next });

    assert.strictEqual(calls.fetches[0].url, next);
});

// Every absolute URL this client sees arrived inside a response body: an upload session URL, an
// @odata.nextLink. `anonymous` says "pre-authenticated, send no token"; without it a tampered body
// naming any host at all would be handed the bearer token.
test("a token is never sent to an absolute url outside graph.microsoft.com", async () => {
    const { client, calls } = harness([reply(200, {})]);

    for (const url of [
        "https://upload.example/session/42",
        "https://graph.microsoft.com.evil.example/v1.0/me/drive/root",
        "https://evil.example/?x=https://graph.microsoft.com",
        "https://",
    ]) {
        await assert.rejects(client.request(1, { url }), /token/i, `accepted ${url}`);
    }

    assert.strictEqual(calls.fetches.length, 0, "nothing may reach the network");
    assert.strictEqual(calls.tokens, 0, "and no token may even be fetched for it");
});

test("the same url is allowed once it is marked pre-authenticated and carries no token", async () => {
    const { client, calls } = harness([reply(200, {})]);

    await client.request(1, { url: "https://upload.example/session/42", method: "PUT", anonymous: true });

    assert.strictEqual(calls.fetches[0].url, "https://upload.example/session/42");
    assert.strictEqual(calls.tokens, 0);
});

// A multi-gigabyte upload outlives an access token. Hoisting it once would kill the transfer an
// hour in, which is exactly the case no unit test would ever reach by accident.
test("the token is fetched again for every attempt", async () => {
    const { client, calls } = harness([reply(429, null, { "retry-after": "1" }), reply(200, {})]);

    await client.request(1, { url: "/root" });

    assert.strictEqual(calls.tokens, 2);
});

test("Retry-After is obeyed rather than guessed", async () => {
    const { client, calls } = harness([reply(429, null, { "retry-after": "3" }), reply(200, {})]);

    await client.request(1, { url: "/root" });

    assert.deepStrictEqual(calls.slept, [3000]);
});

test("a Retry-After beyond the ceiling fails instead of waiting", async () => {
    const { client, calls } = harness([reply(429, null, { "retry-after": "121" })]);

    await assert.rejects(client.request(1, { url: "/root" }), /throttl/i);
    assert.deepStrictEqual(calls.slept, [], "nothing may be waited out beyond the ceiling");
});

// The two ceilings are two numbers and must stay two numbers. Collapsing the total onto the
// single-wait ceiling would let exactly one maximum-length wait ever happen: this pair is legal
// twice over — each wait is inside MAX_WAIT_MS and their sum is well inside what FileTransfer's
// 600 s window for a full pipeline tolerates — and it is precisely what retrying exists for.
test("two waits that are each legal are both waited out even though their sum is not one wait", async () => {
    const { client, calls } = harness([
        reply(429, null, { "retry-after": "100" }),
        reply(429, null, { "retry-after": "30" }),
        reply(200, { value: [] }),
    ]);

    const result = await client.request(1, { url: "/root" });

    assert.deepStrictEqual(result.body, { value: [] }, "the request must survive a backoff this long");
    assert.deepStrictEqual(calls.slept, [100_000, 30_000]);
    assert.ok(calls.slept[0] + calls.slept[1] > MAX_WAIT_MS, "the point of the case is that the sum exceeds one wait");
    assert.ok(calls.slept[0] + calls.slept[1] <= MAX_TOTAL_WAIT_MS);
});

// The default ceiling is not the only clock in the system. A caller sitting under FileTransfer's
// 60 s read-stall window would have a perfectly legitimate 90 s Retry-After honoured here and be
// aborted from above as a stalled read, so it gets to name a shorter budget of its own.
test("a Retry-After above the caller's own ceiling fails without sleeping", async () => {
    const { client, calls } = harness([reply(429, null, { "retry-after": "90" }), reply(200, {})]);

    await assert.rejects(client.request(1, { url: "/root/content", maxWaitMs: 45_000 }), /throttl/i);
    assert.deepStrictEqual(calls.slept, [], "nothing may be waited out beyond the caller's ceiling");
    assert.strictEqual(calls.fetches.length, 1);
});

// One budget is not enough: four waits each inside the single-wait ceiling add up to the same
// wedged transfer as one wait beyond it.
test("waits that add up past the total budget stop rather than continue", async () => {
    const { client, calls } = harness([
        reply(429, null, { "retry-after": "20" }),
        reply(429, null, { "retry-after": "20" }),
        reply(429, null, { "retry-after": "20" }),
        reply(200, {}),
    ]);

    await assert.rejects(client.request(1, { url: "/root/content", maxTotalWaitMs: 45_000 }), /throttl/i);
    assert.deepStrictEqual(calls.slept, [20_000, 20_000], "the third wait would break the total budget");
    assert.strictEqual(calls.fetches.length, 3, "and the request must not be sent a fourth time");
});

test("without Retry-After the wait grows and stays under the ceiling", async () => {
    const { client, calls } = harness([reply(500), reply(500), reply(500), reply(200, {})]);

    await client.request(1, { url: "/root" });

    assert.strictEqual(calls.slept.length, 3);
    for (let i = 1; i < calls.slept.length; i += 1) {
        assert.ok(calls.slept[i] > calls.slept[i - 1], "each wait must be longer than the last");
    }
    for (const waited of calls.slept) assert.ok(waited <= MAX_WAIT_MS, `${waited} exceeds the ceiling`);
});

// At MAX_ATTEMPTS = 5 the largest computed wait is about ten seconds, so no request-level test can
// ever reach the ceiling. Asserted directly instead: raising the attempt count or the base later
// must not be able to remove the cap while the whole suite stays green.
test("the computed wait is capped however far the exponent runs", () => {
    assert.strictEqual(backoffDelay(30, () => 0.5), MAX_WAIT_MS);
    assert.ok(backoffDelay(30, () => 1) <= MAX_WAIT_MS, "positive jitter must not lift it over the ceiling");
    assert.ok(backoffDelay(30, () => 0) <= MAX_WAIT_MS);
    assert.ok(backoffDelay(1, () => 0.5) < MAX_WAIT_MS, "an early attempt must still wait a short time");
});

test("the attempts are bounded and the last failure is reported", async () => {
    const { client, calls } = harness(Array.from({ length: MAX_ATTEMPTS }, () => reply(429)));

    await assert.rejects(client.request(1, { url: "/root" }), /throttl/i);
    assert.strictEqual(calls.fetches.length, MAX_ATTEMPTS);
});

test("a not-found is not retried — it will not become true by waiting", async () => {
    const { client, calls } = harness([reply(404, { error: { code: "itemNotFound" } })]);

    await assert.rejects(client.request(1, { url: "/root:/gone.txt:" }), /exist/i);
    assert.strictEqual(calls.fetches.length, 1);
});

test("a full drive is not retried either", async () => {
    const { client, calls } = harness([reply(507)]);

    await assert.rejects(client.request(1, { url: "/root" }), /full/i);
    assert.strictEqual(calls.fetches.length, 1);
});

// Microsoft may carry the quota code on a status that otherwise looks retryable. Waiting five times
// over does not free up quota, and the answer at the end says the drive is full either way.
test("a full drive carried on a 500 is not retried either", async () => {
    const { client, calls } = harness([reply(500, { error: { code: "quotaLimitReached" } })]);

    await assert.rejects(client.request(1, { url: "/root" }), /full/i);
    assert.strictEqual(calls.fetches.length, 1, "a permanent failure must not be repeated");
    assert.deepStrictEqual(calls.slept, []);
});

// Falling out of the loop threw a bare "temporarily unavailable" with no status and no code:
// an auth failure described as an outage, and nothing for the caller to branch on.
test("an unauthorized answer on the last attempt is reported as itself, not as an outage", async () => {
    const { client } = harness([
        reply(500), reply(500), reply(500), reply(500),
        reply(401, { error: { code: "InvalidAuthenticationToken" } }),
    ]);

    await assert.rejects(client.request(1, { url: "/root" }), (error) => {
        assert.strictEqual(error.status, 401);
        assert.strictEqual(error.code, "InvalidAuthenticationToken");
        assert.doesNotMatch(error.message, /temporarily/i, "a rejected token is not an outage");
        return true;
    });
});

test("the thrown error carries status and code for the caller to branch on", async () => {
    const { client } = harness([reply(409, { error: { code: "nameAlreadyExists" } })]);

    await assert.rejects(client.request(1, { url: "/root" }), (error) => {
        assert.strictEqual(error.status, 409);
        assert.strictEqual(error.code, "nameAlreadyExists");
        return true;
    });
});

test("a stale token is dropped once and the call repeated", async () => {
    const { client, calls } = harness([reply(401), reply(200, {})]);

    await client.request(7, { url: "/root" });

    assert.deepStrictEqual(calls.forgotten, [7]);
    assert.strictEqual(calls.fetches.length, 2);
});

// Without the "once" the pair of 401s would loop until the attempt cap, hammering the token store.
test("a second unauthorized answer is not retried again", async () => {
    const { client, calls } = harness([reply(401), reply(401)]);

    await assert.rejects(client.request(1, { url: "/root" }));
    assert.strictEqual(calls.forgotten.length, 1);
    assert.strictEqual(calls.fetches.length, 2);
});

test("an already aborted signal never reaches the network", async () => {
    const { client, calls } = harness([reply(200, {})]);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(client.request(1, { url: "/root", signal: controller.signal }), /cancel/i);
    assert.strictEqual(calls.fetches.length, 0);
});

test("an abort during the call is not retried", async () => {
    const controller = new AbortController();
    const { client, calls } = harness([() => {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
    }]);

    await assert.rejects(client.request(1, { url: "/root", signal: controller.signal }), /cancel/i);
    assert.deepStrictEqual(calls.slept, []);
});

test("a network failure is retried", async () => {
    const { client, calls } = harness([() => { throw new TypeError("fetch failed"); }, reply(200, {})]);

    await client.request(1, { url: "/root" });

    assert.strictEqual(calls.fetches.length, 2);
});

// The upload session URL comes out of a response body. Attaching the bearer token to it would
// make that body a place where a token could be redirected to.
test("an anonymous request carries no token and asks for none", async () => {
    const { client, calls } = harness([reply(200, {})]);

    await client.request(1, { url: "https://upload.example/s", method: "PUT", anonymous: true });

    assert.strictEqual(calls.fetches[0].options.headers.Authorization, undefined);
    assert.strictEqual(calls.tokens, 0);
});

test("parse raw hands the response back untouched, body included", async () => {
    const response = reply(200, {});
    const { client } = harness([response]);

    assert.strictEqual(await client.request(1, { url: "/root/content", parse: "raw" }), response);
});

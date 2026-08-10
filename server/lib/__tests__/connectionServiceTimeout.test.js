const test = require("node:test");
const assert = require("node:assert");
const { withTimeout, connectWithDeadline, CROSS_TRANSFER_CONNECT_TIMEOUT_MS } = require("../ConnectionService");

// Small, real deadlines throughout (a few ms) rather than fake timers: no test in this repo mocks
// modules or global timers, and CROSS_TRANSFER_CONNECT_TIMEOUT_MS itself only needs to be short
// here, not real, to exercise the same code paths.
const SHORT_MS = 15;

test("CROSS_TRANSFER_CONNECT_TIMEOUT_MS matches the other connection-adjacent deadlines in this codebase", () => {
    assert.strictEqual(CROSS_TRANSFER_CONNECT_TIMEOUT_MS, 30000);
});

test("withTimeout resolves normally when the promise settles first", async () => {
    let timedOut = false;
    const result = await withTimeout(Promise.resolve("client"), 1000, "should not fire", () => { timedOut = true; });
    assert.strictEqual(result, "client");
    assert.strictEqual(timedOut, false);
});

test("withTimeout rejects with its own message once the deadline passes, and reports it", async () => {
    let timedOut = false;
    const neverSettles = new Promise(() => {});
    await assert.rejects(
        () => withTimeout(neverSettles, SHORT_MS, "Timed out opening test connection", () => { timedOut = true; }),
        /Timed out opening test connection/
    );
    assert.strictEqual(timedOut, true);
});

// Fix round 3, Finding 1: onTimeout must fire only when the TIMER wins, not whenever the race
// rejects — otherwise a genuine connection failure (bad credentials, DNS failure) would be
// misreported as a timeout everywhere onTimeout is used to distinguish the two.
test("withTimeout does not report a timeout when the promise itself rejects first", async () => {
    let timedOut = false;
    await assert.rejects(
        () => withTimeout(Promise.reject(new Error("ECONNREFUSED")), 1000, "should not fire", () => { timedOut = true; }),
        /ECONNREFUSED/
    );
    assert.strictEqual(timedOut, false, "a real connection failure must not be reported as a timeout");
});

test("connectWithDeadline behaves like the plain attempt when no deadline is given", async () => {
    const conn = {};
    const client = {};
    const result = await connectWithDeadline(conn, "clientKey", "connectingKey", Promise.resolve(client), undefined, "test");
    assert.strictEqual(result, client);
    assert.strictEqual(conn.connectingKey, null, "the connecting slot must clear once settled");
});

test("connectWithDeadline resolves normally when the attempt settles before the deadline", async () => {
    const conn = {};
    const client = {};
    const result = await connectWithDeadline(conn, "clientKey", "connectingKey", Promise.resolve(client), 1000, "test");
    assert.strictEqual(result, client);
    assert.strictEqual(conn.connectingKey, null);
});

// Fix round 3, Finding 1: this is the guarantee the whole fix rests on — after the deadline, the
// caller's own await always settles (rejects), and the shared connectingKey slot is freed for a
// retry instead of staying wedged on the same doomed attempt forever.
test("connectWithDeadline rejects and frees the connecting slot once a hanging attempt's deadline passes", async () => {
    const conn = {};
    const neverSettles = new Promise(() => {});

    const promise = connectWithDeadline(conn, "clientKey", "connectingKey", neverSettles, SHORT_MS, "cross-transfer");
    // The caller sees the shared promise synchronously, exactly like a concurrent co-waiter would.
    assert.strictEqual(conn.connectingKey, promise);

    await assert.rejects(() => promise, /Timed out opening cross-transfer connection/);
    assert.strictEqual(conn.connectingKey, null, "a retry must not be stuck behind the same expired attempt");
});

// Fix round 3: attempt cannot actually be cancelled. If it succeeds anyway, after the caller has
// already given up and moved on, the stray client must not be left cached under clientKey for some
// unrelated later call (reusing the same key once its own owner releases it) to silently inherit —
// possibly pointed at a different host than the new call expects.
test("connectWithDeadline evicts and closes a connection that arrives after its own deadline", async () => {
    const conn = {};
    let resolveAttempt;
    let closed = false;
    const client = { close: () => { closed = true; } };
    const attempt = new Promise((resolve) => { resolveAttempt = resolve; })
        .then((c) => { conn.clientKey = c; return c; }); // mirrors what the real IIFE does in ConnectionService.js

    const promise = connectWithDeadline(conn, "clientKey", "connectingKey", attempt, SHORT_MS, "cross-transfer");
    await assert.rejects(() => promise);

    resolveAttempt(client);
    // Let the eviction's own .then() handler run — it is a separate microtask chain from `attempt`.
    await new Promise((r) => setTimeout(r, 5));

    assert.strictEqual(conn.clientKey, null, "a late success must not be left cached for an unrelated caller to inherit");
    assert.strictEqual(closed, true, "the orphaned connection must be closed, not merely forgotten");
});

// A late success must not undo a legitimate, newer connection that has since taken clientKey's
// place — eviction only ever removes exactly the stray client it was tracking.
test("connectWithDeadline's eviction leaves a since-replaced clientKey alone", async () => {
    const conn = {};
    let resolveAttempt;
    let staleClosed = false;
    const staleClient = { close: () => { staleClosed = true; } };
    const freshClient = {};
    const attempt = new Promise((resolve) => { resolveAttempt = resolve; });

    const promise = connectWithDeadline(conn, "clientKey", "connectingKey", attempt, SHORT_MS, "cross-transfer");
    await assert.rejects(() => promise);

    conn.clientKey = freshClient; // a fully independent, later call already installed its own client
    resolveAttempt(staleClient);
    await new Promise((r) => setTimeout(r, 5));

    assert.strictEqual(conn.clientKey, freshClient, "a newer, unrelated connection must survive");
    assert.strictEqual(staleClosed, false, "eviction must not reach for a client it does not own anymore");
});

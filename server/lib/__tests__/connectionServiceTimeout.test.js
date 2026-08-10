const test = require("node:test");
const assert = require("node:assert");
const {
    withTimeout,
    connectWithDeadline,
    crossTransferKeys,
    CROSS_TRANSFER_CONNECT_TIMEOUT_MS,
} = require("../ConnectionService");
const controlPlane = require("../controlPlane/ControlPlaneServer");

// Small, real deadlines throughout (a few ms) rather than fake timers: no test in this repo mocks
// modules or global timers, and CROSS_TRANSFER_CONNECT_TIMEOUT_MS itself only needs to be short
// here, not real, to exercise the same code paths.
const SHORT_MS = 15;

// A finished connection attempt, in the shape getAuxiliarySFTPClient hands to connectWithDeadline.
const opened = (over = {}) => ({ client: { close: () => {} }, engineSessionId: null, ...over });

const spyOnCloseSession = () => {
    const original = controlPlane.closeSession;
    const calls = [];
    controlPlane.closeSession = (...args) => { calls.push(args); };
    return { calls, restore: () => { controlPlane.closeSession = original; } };
};

// Fix round 4: the deadline itself was pinned in isolation, but nothing showed that the
// cross-transfer path ever hands it over — deleting the timeoutMs line from crossTransferKeys (or
// weakening it to a falsy 0, which connectWithDeadline reads as "no deadline at all") left the
// whole suite green while every cross-transfer connect went back to waiting forever. This is the
// one line the round rests on. A bare "the constant is 30000" assertion, which this replaces,
// proved nothing about that wiring.
test("the cross-transfer path is the one that carries the connect deadline", () => {
    const keys = crossTransferKeys("t1");
    assert.strictEqual(keys.timeoutMs, CROSS_TRANSFER_CONNECT_TIMEOUT_MS);
    assert.ok(Number.isFinite(keys.timeoutMs) && keys.timeoutMs > 0,
        "a falsy or infinite deadline is the same as no deadline to connectWithDeadline");
    // The other callers (the primary connection, transfer/background/ai clients) deliberately pass
    // no timeoutMs at all; connectWithDeadline's own no-deadline test below covers what they get.
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

// Fix round 4: the clearTimeout in withTimeout's finally is load-bearing and was untested — the
// timer is deliberately not unref()'d, so without it every single connection that succeeds leaves
// a live 30 s timer behind, holding the event loop open and firing onTimeout long after the caller
// has moved on. Observed here through onTimeout rather than through timer internals.
test("withTimeout leaves no live timer behind once the promise has settled", async () => {
    let timedOut = false;
    await withTimeout(Promise.resolve("client"), SHORT_MS, "should not fire", () => { timedOut = true; });
    await new Promise((r) => setTimeout(r, SHORT_MS * 3));
    assert.strictEqual(timedOut, false, "the deadline must not still fire after the attempt is done");
});

test("connectWithDeadline behaves like the plain attempt when no deadline is given", async () => {
    const conn = {};
    const done = opened();
    const result = await connectWithDeadline(conn, "clientKey", "connectingKey", Promise.resolve(done), undefined, "test");
    assert.strictEqual(result, done.client);
    assert.strictEqual(conn.clientKey, done.client, "a connection nobody gave up on is cached for reuse");
    assert.strictEqual(conn.connectingKey, null, "the connecting slot must clear once settled");
});

test("connectWithDeadline resolves normally when the attempt settles before the deadline", async () => {
    const conn = {};
    const done = opened();
    const result = await connectWithDeadline(conn, "clientKey", "connectingKey", Promise.resolve(done), 1000, "test");
    assert.strictEqual(result, done.client);
    assert.strictEqual(conn.clientKey, done.client);
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
//
// Fix round 4: closing the socket is only half of it. close() destroys the socket; the engine
// session behind it lives on until the master session ends unless the control plane is told
// separately — and by that point the registry slot that capped this connection is long released,
// so nothing counts these any more. A peer that stalls past every deadline and then answers would
// otherwise open a fresh engine session per attempt, without limit.
test("connectWithDeadline closes both the socket and the engine session of a late arrival", async () => {
    const conn = { auxSessionIds: new Set(["s-late"]) };
    let resolveAttempt;
    let closed = false;
    const done = opened({ client: { close: () => { closed = true; } }, engineSessionId: "s-late" });
    const attempt = new Promise((resolve) => { resolveAttempt = resolve; });

    const spy = spyOnCloseSession();
    try {
        await assert.rejects(() => connectWithDeadline(conn, "clientKey", "connectingKey", attempt, SHORT_MS, "cross-transfer"));

        resolveAttempt(done);
        // Let the publish/evict handler run — it is a separate microtask chain from `attempt`.
        await new Promise((r) => setTimeout(r, 5));

        assert.strictEqual(conn.clientKey, undefined, "a late success must not be cached for an unrelated caller to inherit");
        assert.strictEqual(closed, true, "the orphaned socket must be closed, not merely forgotten");
        assert.deepStrictEqual(spy.calls, [["s-late"]], "the engine session must be closed with the control plane too");
        assert.strictEqual(conn.auxSessionIds.has("s-late"), false, "and taken back out of the connection's bookkeeping");
    } finally {
        spy.restore();
    }
});

// Fix round 4, replacing a test that modelled a state the real path cannot produce (it wrote the
// stale client under clientKey itself and then checked that eviction spared a value that had
// replaced it). What actually has to hold: a late arrival never publishes at all, so a legitimate,
// newer connection sitting under the same key is neither overwritten nor closed nor nulled — the
// late attempt only ever touches what it opened itself.
test("a late arrival leaves a newer, legitimate connection under the same key untouched", async () => {
    const conn = { auxSessionIds: new Set(["s-stale", "s-fresh"]) };
    let resolveAttempt;
    let staleClosed = false;
    let freshClosed = false;
    const freshClient = { close: () => { freshClosed = true; } };
    const done = opened({ client: { close: () => { staleClosed = true; } }, engineSessionId: "s-stale" });
    const attempt = new Promise((resolve) => { resolveAttempt = resolve; });

    const spy = spyOnCloseSession();
    try {
        await assert.rejects(() => connectWithDeadline(conn, "clientKey", "connectingKey", attempt, SHORT_MS, "cross-transfer"));

        // A fully independent, later call has meanwhile opened and cached its own connection.
        conn.clientKey = freshClient;
        resolveAttempt(done);
        await new Promise((r) => setTimeout(r, 5));

        assert.strictEqual(conn.clientKey, freshClient, "a newer, unrelated connection must survive");
        assert.strictEqual(freshClosed, false, "and must not be closed by someone else's cleanup");
        assert.strictEqual(staleClosed, true, "while the stale one is still cleaned up");
        assert.deepStrictEqual(spy.calls, [["s-stale"]], "only its own engine session, never the newer one's");
        assert.strictEqual(conn.auxSessionIds.has("s-fresh"), true, "the newer engine session stays registered");
    } finally {
        spy.restore();
    }
});

test("a late arrival with a close() that throws still reaches the control plane", async () => {
    const conn = {};
    let resolveAttempt;
    const done = opened({
        client: { close: () => { throw new Error("socket already destroyed"); } },
        engineSessionId: "s-throw",
    });
    const attempt = new Promise((resolve) => { resolveAttempt = resolve; });

    const spy = spyOnCloseSession();
    try {
        await assert.rejects(() => connectWithDeadline(conn, "clientKey", "connectingKey", attempt, SHORT_MS, "cross-transfer"));
        resolveAttempt(done);
        await new Promise((r) => setTimeout(r, 5));
        assert.deepStrictEqual(spy.calls, [["s-throw"]]);
    } finally {
        spy.restore();
    }
});

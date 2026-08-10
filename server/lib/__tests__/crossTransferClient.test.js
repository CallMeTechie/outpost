const test = require("node:test");
const assert = require("node:assert");
const {
    crossTransferKeys,
    getSFTPCrossTransferClient,
    releaseSFTPCrossTransferClient,
} = require("../ConnectionService");
const SessionManager = require("../SessionManager");
const controlPlane = require("../controlPlane/ControlPlaneServer");

// Swaps controlPlane.closeSession for a spy and returns a restore function, so tests can assert
// the control plane was actually told to close a session without needing a real engine attached.
const spyOnCloseSession = () => {
    const original = controlPlane.closeSession;
    const calls = [];
    controlPlane.closeSession = (...args) => { calls.push(args); };
    return { calls, restore: () => { controlPlane.closeSession = original; } };
};

test("each transfer gets its own client key", () => {
    const a = crossTransferKeys("t1");
    const b = crossTransferKeys("t2");

    assert.notStrictEqual(a.clientKey, b.clientKey);
    assert.strictEqual(a.suffix, "cxfer");
    assert.match(a.clientKey, /t1/);
});

test("keys are stable for the same transfer id", () => {
    assert.deepStrictEqual(crossTransferKeys("t1"), crossTransferKeys("t1"));
});

test("releasing a transfer closes the client and clears every bookkeeping entry", () => {
    let closed = 0;
    const conn = {
        auxSessionIds: new Set(["s-cxfer-1"]),
        "crossTransferClient:t1": {},
        // getAuxiliarySFTPClient leaves this behind as null once it is done connecting; the same
        // dead property the clientKey delete exists to avoid, only per transfer id.
        "_crossTransferConnecting:t1": null,
        crossTransferClients: new Map([
            ["t1", {
                client: { close: () => { closed += 1; } },
                engineSessionId: "s-cxfer-1",
                clientKey: "crossTransferClient:t1",
            }],
        ]),
    };

    releaseSFTPCrossTransferClient(conn, "t1");

    assert.strictEqual(closed, 1);
    assert.strictEqual(conn.auxSessionIds.size, 0);
    assert.strictEqual("crossTransferClient:t1" in conn, false, "no dead property may survive");
    assert.strictEqual("_crossTransferConnecting:t1" in conn, false, "the connecting key must go too");
    assert.strictEqual(conn.crossTransferClients.size, 0);
});

test("releasing transfer A leaves transfer B untouched", () => {
    let closedB = 0;
    const conn = {
        auxSessionIds: new Set(["s-a", "s-b"]),
        crossTransferClients: new Map([
            ["a", { client: { close: () => {} }, engineSessionId: "s-a", clientKey: "crossTransferClient:a" }],
            ["b", { client: { close: () => { closedB += 1; } }, engineSessionId: "s-b", clientKey: "crossTransferClient:b" }],
        ]),
    };

    releaseSFTPCrossTransferClient(conn, "a");

    assert.strictEqual(closedB, 0, "a cancelled transfer must not tear down another one");
    assert.strictEqual(conn.crossTransferClients.size, 1);
});

test("releasing an unknown transfer id is a no-op", () => {
    assert.doesNotThrow(() => releaseSFTPCrossTransferClient({ crossTransferClients: new Map() }, "nope"));
    assert.doesNotThrow(() => releaseSFTPCrossTransferClient({}, "nope"));
});

// Finding 1: getAuxiliarySFTPClient only calls onEngineSession while opening a fresh engine
// session. Once the client is already cached on conn[clientKey], it short-circuits and returns
// without ever calling that callback — so a second call for the same transferId must not let a
// then-null local engineSessionId stomp the bookkeeping entry a first call already filled in.
test("calling getSFTPCrossTransferClient twice for the same transferId keeps its engineSessionId", async () => {
    const session = SessionManager.create("acc-1", "entry-1", {});
    const transferId = "t-cache";
    const keys = crossTransferKeys(transferId);
    const engineSessionId = "engine-session-1";
    // Pre-populate the connection as if a real first call had already opened the engine session
    // and cached the client — this is exactly the state getAuxiliarySFTPClient's cache-hit branch
    // sees, so both calls below take that branch without touching the network layer at all.
    const fakeClient = { _closed: false, close: () => {} };
    SessionManager.setConnection(session.sessionId, {
        [keys.clientKey]: fakeClient,
        auxSessionIds: new Set([engineSessionId]),
        crossTransferClients: new Map([
            [transferId, { client: fakeClient, engineSessionId, clientKey: keys.clientKey }],
        ]),
    });
    const conn = SessionManager.getConnection(session.sessionId);

    const first = await getSFTPCrossTransferClient(session.sessionId, {}, "acc-1", transferId);
    assert.strictEqual(first, fakeClient);
    assert.strictEqual(
        conn.crossTransferClients.get(transferId).engineSessionId,
        engineSessionId,
        "first call must not blank out the engineSessionId that is already there"
    );

    const second = await getSFTPCrossTransferClient(session.sessionId, {}, "acc-1", transferId);
    assert.strictEqual(second, fakeClient);
    assert.strictEqual(
        conn.crossTransferClients.get(transferId).engineSessionId,
        engineSessionId,
        "second call must still keep the engineSessionId around"
    );

    const spy = spyOnCloseSession();
    try {
        releaseSFTPCrossTransferClient(conn, transferId);
        assert.deepStrictEqual(spy.calls, [[engineSessionId]], "release must reach the control plane with the real id");
        assert.strictEqual(conn.auxSessionIds.has(engineSessionId), false);
    } finally {
        spy.restore();
    }
});

// Finding 2: without this test, deleting the controlPlane.closeSession call from
// releaseSFTPCrossTransferClient leaves every other assertion in this file green — the engine
// session would leak until the master session ends, and nothing here would notice.
test("releasing a transfer notifies the control plane with the transfer's engineSessionId", () => {
    const conn = {
        auxSessionIds: new Set(["s-notify"]),
        crossTransferClients: new Map([
            ["t-notify", { client: { close: () => {} }, engineSessionId: "s-notify", clientKey: "crossTransferClient:t-notify" }],
        ]),
    };

    const spy = spyOnCloseSession();
    try {
        releaseSFTPCrossTransferClient(conn, "t-notify");
        assert.deepStrictEqual(spy.calls, [["s-notify"]]);
    } finally {
        spy.restore();
    }
});

// Finding 3: close() failing (e.g. the socket is already dead) must not abort the rest of the
// cleanup — the control plane still has to be told, and every bookkeeping entry still has to go.
test("release still cleans up fully when client.close() throws", () => {
    const conn = {
        auxSessionIds: new Set(["s-throw"]),
        "crossTransferClient:t-throw": {},
        crossTransferClients: new Map([
            ["t-throw", {
                client: { close: () => { throw new Error("socket already destroyed"); } },
                engineSessionId: "s-throw",
                clientKey: "crossTransferClient:t-throw",
            }],
        ]),
    };

    const spy = spyOnCloseSession();
    try {
        assert.doesNotThrow(() => releaseSFTPCrossTransferClient(conn, "t-throw"));
        assert.deepStrictEqual(spy.calls, [["s-throw"]]);
        assert.strictEqual(conn.auxSessionIds.has("s-throw"), false);
        assert.strictEqual("crossTransferClient:t-throw" in conn, false);
        assert.strictEqual(conn.crossTransferClients.size, 0);
    } finally {
        spy.restore();
    }
});

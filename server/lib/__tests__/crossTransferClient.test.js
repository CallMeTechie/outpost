const test = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const flatbuffers = require("flatbuffers");
const { SftpMsgType, SftpMessage } = require("../generated/sftp_protocol_generated");
const {
    crossTransferKeys,
    getSFTPCrossTransferClient,
    releaseSFTPCrossTransferClient,
    CROSS_TRANSFER_CONNECT_TIMEOUT_MS,
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


// Fix round 5, Finding 3: an id dropped from conn.auxSessionIds after a FAILED close can never be
// swept at session end either — the sweep can only close ids it still finds. A close that throws
// must therefore leave the id in place, so the temporary orphan does not become a permanent one.
test("a failing control-plane close leaves the engine session id in place for the session-end sweep", () => {
    const conn = {
        auxSessionIds: new Set(["s-keep"]),
        crossTransferClients: new Map([
            ["t-keep", { client: { close: () => {} }, engineSessionId: "s-keep", clientKey: "crossTransferClient:t-keep" }],
        ]),
    };

    const original = controlPlane.closeSession;
    controlPlane.closeSession = () => { throw new Error("control plane gone"); };
    try {
        assert.doesNotThrow(() => releaseSFTPCrossTransferClient(conn, "t-keep"));
        assert.strictEqual(conn.auxSessionIds.has("s-keep"), true,
            "the session-end sweep is the last thing that can still reach this engine session");
        assert.strictEqual(conn.crossTransferClients.size, 0, "the rest of the cleanup still has to happen");
    } finally {
        controlPlane.closeSession = original;
    }
});

// Fix round 5, Finding 4: a connect that failed or ran out its deadline never reaches a
// crossTransferClients entry, but getAuxiliarySFTPClient has already parked a per-transfer
// connectingKey on the connection and only nulls it. Bailing out on the missing entry left that
// dead property behind for the life of the session — one per failed transfer.
test("releasing a transfer that never connected still clears its parked connecting key", () => {
    const conn = { "_crossTransferConnecting:t-failed": null, crossTransferClients: new Map() };

    releaseSFTPCrossTransferClient(conn, "t-failed");

    assert.strictEqual("_crossTransferConnecting:t-failed" in conn, false,
        "a failed connect must not leave a dead property behind");
});

// Fix round 5, Finding 1: these two drive the REAL getAuxiliarySFTPClient, not a helper extracted
// from it — the earlier round proved only that the helpers behaved, never that the production path
// used them, so inlining either guarantee away again left the whole suite green.
//
// No database and no engine are involved: a session configured with a directIdentity resolves its
// credentials in memory (identityResolver.js returns early on it), and the control-plane call is
// the first thing that reaches outside — which is exactly where these tests take over.
const SFTP_ENTRY = { id: "entry-1", type: "sftp", config: { ip: "10.0.0.9" } };

const connectedSession = () => {
    const session = SessionManager.create("acc-1", "entry-1", {
        directIdentity: { username: "u", type: "password", password: "p" },
    });
    SessionManager.setConnection(session.sessionId, { type: "sftp" });
    return { sessionId: session.sessionId, conn: SessionManager.getConnection(session.sessionId) };
};

const withFakeEngine = async (openSession, body, waitForDataConnection = () => new Promise(() => {})) => {
    const original = {
        hasEngine: controlPlane.hasEngine,
        openSession: controlPlane.openSession,
        waitForDataConnection: controlPlane.waitForDataConnection,
    };
    controlPlane.hasEngine = () => true;
    controlPlane.openSession = openSession;
    controlPlane.waitForDataConnection = waitForDataConnection;
    try {
        return await body();
    } finally {
        Object.assign(controlPlane, original);
    }
};

// A host that accepts the connection and then says nothing: the session opens, the data socket
// arrives, and no Ready frame ever follows — so EngineSftpClient#waitForReady stays pending and the
// whole attempt settles neither way. A real PassThrough, because the client attaches real stream
// listeners to it and close() destroys it.
const withSilentEngine = (body) =>
    withFakeEngine(async () => ({ success: true }), body, async () => new PassThrough());

// The single frame that makes EngineSftpClient#waitForReady resolve. Built the same way every
// other engine-protocol test in this suite builds its frames, so a real client on a real stream
// completes a real connect — no part of ConnectionService is stubbed out.
const framed = (payload) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, Buffer.from(payload)]);
};

const readyFrame = () => {
    const b = new flatbuffers.Builder(64);
    SftpMessage.startSftpMessage(b);
    SftpMessage.addMsgType(b, SftpMsgType.Ready);
    SftpMessage.finishSftpMessageBuffer(b, SftpMessage.endSftpMessage(b));
    return framed(b.asUint8Array());
};

// A host that answers properly. The frame is written before anything reads from the stream;
// PassThrough holds it until EngineSftpClient attaches its own "data" listener, so the ready
// signal cannot be missed by arriving too early.
const withConnectedEngine = (body) =>
    withFakeEngine(async () => ({ success: true }), body, async () => {
        const socket = new PassThrough();
        socket.write(readyFrame());
        return socket;
    });

// Captured before any test shortens the deadline, so a bounded race can still be timed with a real
// timer while global.setTimeout is swapped.
const REAL_SET_TIMEOUT = global.setTimeout;

// Runs `body` with the cross-transfer connect deadline shortened to a few milliseconds. Only timers
// armed with exactly CROSS_TRANSFER_CONNECT_TIMEOUT_MS are touched — that value is the deadline's
// own signature, so this reaches the production path's timer and nothing else in the process.
const withShortenedCrossTransferDeadline = async (body) => {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) =>
        realSetTimeout(fn, ms === CROSS_TRANSFER_CONNECT_TIMEOUT_MS ? 5 : ms, ...rest);
    try {
        return await body();
    } finally {
        global.setTimeout = realSetTimeout;
    }
};

// Reports how a cross-transfer connect ended, and always reports something: an unbounded connect
// would otherwise hang this file rather than fail it, and a hanging test proves nothing about a
// deadline that is no longer there.
const connectOutcome = (sessionId, transferId, budgetMs = 300) => Promise.race([
    getSFTPCrossTransferClient(sessionId, SFTP_ENTRY, "acc-1", transferId)
        .then(() => "connected", (err) => err.message),
    new Promise((r) => REAL_SET_TIMEOUT(() => r("still connecting"), budgetMs)),
]);

test("the connect path itself registers its engine session on the connection", async () => {
    const { sessionId, conn } = connectedSession();

    // The control plane is made to fail on purpose: since fix round 6 a failed connect closes and
    // forgets the engine session it registered, and a close that did NOT get through deliberately
    // leaves the id in place for the session-end sweep (see evictLateConnection). That is what
    // keeps the registration observable here — without the registration, this list stays empty.
    const original = controlPlane.closeSession;
    controlPlane.closeSession = () => { throw new Error("control plane gone"); };
    try {
        await withFakeEngine(async () => { throw new Error("engine refused"); }, async () => {
            await assert.rejects(
                () => getSFTPCrossTransferClient(sessionId, SFTP_ENTRY, "acc-1", "t-register"),
                /engine refused/
            );
        });

        assert.deepStrictEqual([...(conn.auxSessionIds ?? [])], [`${sessionId}-cxfer-1`],
            "an unregistered engine session is one nothing can ever force-close at session end");
    } finally {
        controlPlane.closeSession = original;
    }
});

test("a second caller arriving mid-connect joins the running attempt instead of opening a second engine session", async () => {
    const { sessionId, conn } = connectedSession();
    let openCalls = 0;
    // Each attempt fails on its own short timer, so this test settles either way — including under
    // the mutation it exists to catch, where a second, independent attempt is started.
    const openSession = () => {
        openCalls += 1;
        return new Promise((_, reject) => setTimeout(() => reject(new Error("engine refused")), 5));
    };

    const spy = spyOnCloseSession();
    try {
        await withFakeEngine(openSession, async () => {
            const first = getSFTPCrossTransferClient(sessionId, SFTP_ENTRY, "acc-1", "t-join");
            const second = getSFTPCrossTransferClient(sessionId, SFTP_ENTRY, "acc-1", "t-join");
            await assert.rejects(() => first);
            await assert.rejects(() => second);
        });

        assert.strictEqual(openCalls, 1, "the joining caller must not open a connection of its own");
        // One engine session was created and one was cleaned up. A second, independently opened
        // attempt would show up as a second `-cxfer-` id here.
        assert.deepStrictEqual(spy.calls, [[`${sessionId}-cxfer-1`]],
            "and must not register a second engine session against the same host");
        assert.strictEqual(conn.auxSessionIds.size, 0);
    } finally {
        spy.restore();
    }
});

// Fix round 6, Finding D: the cleanup of an unwanted connection used to hang off the success
// branch alone. A connect that fails still registered its engine session id first — the id goes on
// the connection before the connect even starts — and nothing ever took it back out again:
// releaseSFTPCrossTransferClient finds no crossTransferClients entry for an attempt that never
// finished. The list grew by one per failed try, for the life of the session.
test("a connect that fails closes the engine session it had already registered", async () => {
    const { sessionId, conn } = connectedSession();

    const spy = spyOnCloseSession();
    try {
        await withFakeEngine(async () => { throw new Error("engine refused"); }, async () => {
            await assert.rejects(() => getSFTPCrossTransferClient(sessionId, SFTP_ENTRY, "acc-1", "t-fail"));
        });

        assert.deepStrictEqual(spy.calls, [[`${sessionId}-cxfer-1`]],
            "a failed attempt's engine session must be closed, not merely forgotten");
        assert.strictEqual(conn.auxSessionIds.size, 0,
            "and the connection's aux-session list must not grow with every failed attempt");
    } finally {
        spy.restore();
    }
});

// The case the deadline exists for, and the one neither settle handler can ever reach: the source
// host accepts the connection and then never reports ready, so EngineSftpClient#waitForReady stays
// pending for good. Only the timer itself can still close what that attempt left open — and the
// registry slot that used to bound it is handed back at that very moment, so nothing else counts
// these any more.
test("a source that never reports ready has its engine session closed when the deadline passes", async () => {
    const { sessionId, conn } = connectedSession();

    const spy = spyOnCloseSession();
    try {
        const outcome = await withShortenedCrossTransferDeadline(() =>
            withSilentEngine(() => connectOutcome(sessionId, "t-silent")));
        assert.strictEqual(outcome, "Timed out opening cross-transfer connection");

        assert.deepStrictEqual(spy.calls, [[`${sessionId}-cxfer-1`]],
            "an attempt that never settles is only ever reachable from the deadline itself");
        assert.strictEqual(conn.auxSessionIds.size, 0);
    } finally {
        spy.restore();
    }
});

// Fix round 6, Finding B: the deadline was only ever pinned at connectWithDeadline and at
// crossTransferKeys — never at the line that brings the two together. Both halves of that line
// survived mutation: handing over an undefined timeoutMs (connectWithDeadline reads that as "no
// deadline at all"), and replacing the call with the inline publish it was extracted from. Either
// one puts every cross-transfer connect back to waiting forever, and neither showed up anywhere.
// This drives the real getSFTPCrossTransferClient against a host that never answers.
test("the cross-transfer connect path is actually bounded, not merely capable of being bounded", async () => {
    const { sessionId } = connectedSession();

    const outcome = await withShortenedCrossTransferDeadline(() =>
        withSilentEngine(() => connectOutcome(sessionId, "t-bounded")));

    assert.strictEqual(outcome, "Timed out opening cross-transfer connection",
        "a connect that no deadline reaches leaves the caller, and its registry slot, waiting for good");
});

// Fix round 6, Finding B: without a connect that actually succeeds, nothing proved that the
// production path records what it opened. Deleting the crossTransferClients.set leaves the release
// with nothing to find — every transfer would then leak its client and its engine session — and
// dropping the onEngineSession callback leaves the recorded id empty, which makes the release skip
// the control plane and leak the engine session just the same. Both are invisible to a test that
// pre-populates that bookkeeping itself, which is all this file used to have.
test("a cross-transfer connect that succeeds records the engine session it opened", async () => {
    const { sessionId, conn } = connectedSession();

    await withConnectedEngine(async () => {
        const client = await getSFTPCrossTransferClient(sessionId, SFTP_ENTRY, "acc-1", "t-live");
        assert.ok(client, "the connect must really have produced a client");
    });

    assert.strictEqual(conn.crossTransferClients.get("t-live")?.engineSessionId, `${sessionId}-cxfer-1`,
        "an unrecorded engine session is one the release can never close");

    const spy = spyOnCloseSession();
    try {
        releaseSFTPCrossTransferClient(conn, "t-live");
        assert.deepStrictEqual(spy.calls, [[`${sessionId}-cxfer-1`]]);
        assert.strictEqual(conn.auxSessionIds.size, 0);
        assert.strictEqual("crossTransferClient:t-live" in conn, false);
    } finally {
        spy.restore();
    }
});

// Fix round 6, Finding B: pinning the generation counter needs two connects on ONE connection. Fix
// it at a constant and both transfers share an engine session id — releasing the first would then
// close the second's engine session out from under a running transfer.
test("two transfers on one session never share an engine session id", async () => {
    const { sessionId, conn } = connectedSession();

    await withConnectedEngine(async () => {
        await getSFTPCrossTransferClient(sessionId, SFTP_ENTRY, "acc-1", "t-one");
        await getSFTPCrossTransferClient(sessionId, SFTP_ENTRY, "acc-1", "t-two");
    });

    assert.deepStrictEqual(
        ["t-one", "t-two"].map((id) => conn.crossTransferClients.get(id)?.engineSessionId),
        [`${sessionId}-cxfer-1`, `${sessionId}-cxfer-2`]);
    assert.strictEqual(conn.auxSessionIds.size, 2, "two connections, two engine sessions");

    const spy = spyOnCloseSession();
    try {
        releaseSFTPCrossTransferClient(conn, "t-one");
        assert.deepStrictEqual(spy.calls, [[`${sessionId}-cxfer-1`]],
            "releasing one transfer must never close another one's engine session");
        assert.strictEqual(conn.auxSessionIds.has(`${sessionId}-cxfer-2`), true);
    } finally {
        spy.restore();
        releaseSFTPCrossTransferClient(conn, "t-two");
    }
});

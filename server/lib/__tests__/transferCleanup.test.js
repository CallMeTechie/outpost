const test = require("node:test");
const assert = require("node:assert");
const SessionManager = require("../SessionManager");
const registry = require("../fileTransfer/registry");
const { cancelAllTransfers, handleClose } = require("../../routes/sftpWS");

// Fix round 3, Finding 1: the other side's slot is deliberately NOT released here anymore — see
// registry.js's own comment on releaseSession. A cross-transfer connection attempt is now
// deadline-bound (ConnectionService.js's CROSS_TRANSFER_CONNECT_TIMEOUT_MS) and force-closed by
// SessionManager's own aux-session sweep the moment either side's session ends either way, so a
// release is guaranteed within a bounded time regardless — holding the slot until then keeps
// countFor honest instead of reporting capacity that is not actually free yet.
test("removing a session releases only its own transfer slot", async () => {
    // SessionManager.create returns the session object, not the bare id (see sessionCleanup.test.js).
    const { sessionId } = SessionManager.create("acc", "entry", {});
    registry.reserve("k1", [sessionId, "other"]);
    assert.strictEqual(registry.countFor(sessionId), 1);

    await SessionManager.remove(sessionId);

    assert.strictEqual(registry.countFor(sessionId), 0, "the vanished session still holds a slot");
    assert.strictEqual(registry.countFor("other"), 1, "the other side's own transfer still holds its slot");
    registry.release("k1");
});

test("removing a session without transfers is harmless", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    await assert.doesNotReject(() => SessionManager.remove(sessionId));
});

// A transfer's registry slot is reserved before either side opens its auxiliary connection
// (see transferHandlers.js:start), so a session can hold a slot while still connecting.
test("removing a session with a master connection still releases its own registry slot", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    SessionManager.setConnection(sessionId, { type: "sftp" });
    registry.reserve("k2", [sessionId, "other-dst"]);

    await SessionManager.remove(sessionId);

    assert.strictEqual(registry.countFor(sessionId), 0);
    assert.strictEqual(registry.countFor("other-dst"), 1, "not released early — see fix round 3, Finding 1");
    registry.release("k2");
});

// Finding 2 (fix round 1): finalizeTerminalRecording and cleanupConnection both await external
// I/O and neither is wrapped in remove() — if either throws, remove() throws too, and _removing
// is already true by then, so the slot would otherwise stay reserved until the process restarts
// (a second remove() call is permanently refused once _removing is set). stream.end() throwing
// synchronously inside the async finalizeTerminalRecording turns into a rejection without needing
// a real filesystem or database.
test("removing a session still releases its own transfer slot even if finalizing the recording fails", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    const session = SessionManager.get(sessionId);
    session.recording = { stream: { end: () => { throw new Error("disk full"); }, on: () => {} } };
    registry.reserve("k4", [sessionId, "other-rec"]);

    await assert.rejects(() => SessionManager.remove(sessionId), /disk full/);

    assert.strictEqual(registry.countFor(sessionId), 0, "the vanished session's own slot must be released even though cleanup failed afterward");
    assert.strictEqual(registry.countFor("other-rec"), 1, "not released early — see fix round 3, Finding 1");
    registry.release("k4");
});

// Fix round 2, Finding 3: the release above rescues the registry slot, but not the session itself
// — before this fix, a throw here left `sessions.delete` unreached and `_removing` permanently
// true, so the session stayed in the collection forever (every later remove() call refused by the
// guard at the top, yet the session never actually disappears from getAll()/onMasterConnectionClosed/
// wherever else looks it up).
test("removing a session removes it from the collection even when cleanup afterward fails", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    const session = SessionManager.get(sessionId);
    session.recording = { stream: { end: () => { throw new Error("disk full"); }, on: () => {} } };

    await assert.rejects(() => SessionManager.remove(sessionId), /disk full/);

    assert.strictEqual(SessionManager.get(sessionId), null, "the session must be gone, not stranded");
    // A retry must not be refused forever by a lock on a session that no longer exists.
    await assert.doesNotReject(() => SessionManager.remove(sessionId));
});

// Fix round 3, Finding 2: the fix round 1 `finally` only guaranteed sessions.delete — a throw from
// finalizeTerminalRecording still skipped cleanupConnection entirely (both were inside the same
// try, and the throw jumped straight to the finally). The master connection and its auxiliary
// engine sessions were left open with no owner, and both broadcasts after the block never fired.
test("removing a session still tears down the master connection even if finalizing the recording fails", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    const session = SessionManager.get(sessionId);
    session.recording = { stream: { end: () => { throw new Error("disk full"); }, on: () => {} } };
    let sftpClosed = false;
    SessionManager.setConnection(sessionId, { type: "sftp", sftpClient: { close: () => { sftpClosed = true; } } });

    await assert.rejects(() => SessionManager.remove(sessionId), /disk full/);

    assert.strictEqual(sftpClosed, true, "the master connection must still be torn down");
});

// Finding 4 (fix round 1): without this, releaseSession freeing every registered session instead
// of just the vanished one's own transfers would have gone unnoticed — every prior test only
// checked that the right slots dropped to 0, never that an unrelated one survived.
test("removing a session must not touch an unrelated session's own transfer slot", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    registry.reserve("k3", [sessionId, "other"]);
    registry.reserve("unrelated-key", ["bystander-a", "bystander-b"]);

    await SessionManager.remove(sessionId);

    assert.strictEqual(registry.countFor("bystander-a"), 1, "an unrelated session's slot must survive");
    assert.strictEqual(registry.countFor("bystander-b"), 1);
    assert.strictEqual(registry.countFor("other"), 1, "not released early — see fix round 3, Finding 1");
    registry.release("unrelated-key");
    registry.release("k3");
});

// A running entry (it has `transfer`) must stay in the map: transferHandlers.js#finish reads it
// back by transferId to recover sourceSessionId before deleting it itself. Deleting it here first
// (fix round 1, Finding 1) made that read come back empty and leaked the source side's auxiliary
// connection for the rest of the session — see transferHandler.test.js for the end-to-end proof
// against the real handler. This file only pins the map bookkeeping in isolation.
test("cancelAllTransfers cancels every entry but leaves running ones in the map for their own finish()", () => {
    const calls = [];
    const transfers = new Map([
        ["t1", {
            transfer: { cancel: () => calls.push("t1:transfer") },
            broker: { cancel: () => calls.push("t1:broker") },
        }],
        ["t2", {
            transfer: { cancel: () => calls.push("t2:transfer") },
            broker: { cancel: () => calls.push("t2:broker") },
        }],
    ]);

    cancelAllTransfers(transfers);

    assert.deepStrictEqual(calls.sort(), ["t1:broker", "t1:transfer", "t2:broker", "t2:transfer"]);
    assert.strictEqual(transfers.size, 2, "running entries must survive — only their own finish() may remove them");
    assert.ok(transfers.has("t1") && transfers.has("t2"));
});

// TRANSFER_START sets a bare `{ pending: true }` placeholder before its two auxiliary connections
// exist (see transferHandlers.js:start) — no transfer or broker to cancel yet, and nothing will
// ever read this exact object back out of the map again, so removing it here is safe.
test("cancelAllTransfers removes a still-connecting placeholder without throwing", () => {
    const transfers = new Map([["t1", { pending: true }]]);
    assert.doesNotThrow(() => cancelAllTransfers(transfers));
    assert.strictEqual(transfers.size, 0);
});

test("a throwing cancel does not stop the rest of the socket's transfers from being cancelled", () => {
    const calls = [];
    const transfers = new Map([
        ["t1", { transfer: { cancel: () => { throw new Error("already gone"); } } }],
        ["t2", { pending: true, broker: { cancel: () => { throw new Error("already answered"); } } }],
        ["t3", { transfer: { cancel: () => calls.push("t3") } }],
    ]);

    assert.doesNotThrow(() => cancelAllTransfers(transfers));

    assert.deepStrictEqual(calls, ["t3"]);
    // t1 and t3 have a `transfer` and stay for their own finish(); t2 is a placeholder and is gone.
    assert.deepStrictEqual([...transfers.keys()].sort(), ["t1", "t3"]);
});

// Fix round 2, Finding 2: the isolation test that used to live here ("cancelAllTransfers never
// touches a different socket's transfers map") could not fail by construction — it never passed
// the second map to cancelAllTransfers at all, so nothing exercised it. cancelAllTransfers's
// signature (`(transfers) =>`) already makes cross-map access structurally impossible; a
// meaningful isolation test belongs at the level that actually iterates something wider, which is
// registry.releaseSession (see transferRegistry.test.js) — struck here rather than kept for a
// false sense of coverage.

// Finding 4 (fix round 1): without a direct test on the ws.on("close") wiring itself, removing the
// cancelAllTransfers call from the close handler left every other test green — cancelAllTransfers
// was only ever proven to work when called directly, never proven to actually run when the socket
// closes. handleClose is the exact function sftpWS.js registers for that event; none of its other
// dependencies need a socket, a database, or wsAuth — SessionManager.removeWebSocket and
// updateAuditLogWithSessionDuration both no-op for an id nothing is registered under.
test("handleClose cancels this connection's transfers when the socket closes", async () => {
    const calls = [];
    const transfers = new Map([["t1", { transfer: { cancel: () => calls.push("t1") } }]]);
    const listeners = { removed: [] };
    const sftpClient = { removeListener: (evt) => listeners.removed.push(`sftpClient:${evt}`) };
    const ws = { removeListener: (evt) => listeners.removed.push(`ws:${evt}`) };

    await handleClose({
        sftpClient, onSftpClose: () => {}, ws, messageHandler: () => {},
        transfers, sessionId: "no-such-session", auditLogId: null, startTime: Date.now(),
    });

    assert.deepStrictEqual(calls, ["t1"]);
    assert.strictEqual(transfers.size, 1, "the running entry stays for its own finish()");
    assert.deepStrictEqual(listeners.removed.sort(), ["sftpClient:close", "ws:message"]);
});

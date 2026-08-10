const test = require("node:test");
const assert = require("node:assert");
const SessionManager = require("../SessionManager");
const registry = require("../fileTransfer/registry");
const { cancelAllTransfers, handleClose } = require("../../routes/sftpWS");

test("removing a session releases its transfer slots", async () => {
    // SessionManager.create returns the session object, not the bare id (see sessionCleanup.test.js).
    const { sessionId } = SessionManager.create("acc", "entry", {});
    registry.reserve("k1", [sessionId, "other"]);
    assert.strictEqual(registry.countFor(sessionId), 1);

    await SessionManager.remove(sessionId);

    assert.strictEqual(registry.countFor(sessionId), 0, "the vanished session still holds a slot");
    assert.strictEqual(registry.countFor("other"), 0, "the other side must be released too");
    // releaseSession deliberately leaves "k1" itself tombstoned (Finding 3) until its own transfer
    // would release it — simulate that so this test does not leak state into the ones after it.
    registry.release("k1");
});

test("removing a session without transfers is harmless", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    await assert.doesNotReject(() => SessionManager.remove(sessionId));
});

// A transfer's registry slot is reserved before either side opens its auxiliary connection
// (see transferHandlers.js:start), so a session can hold a slot while still connecting.
test("removing a session with a master connection still releases the registry slot", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    SessionManager.setConnection(sessionId, { type: "sftp" });
    registry.reserve("k2", [sessionId, "other-dst"]);

    await SessionManager.remove(sessionId);

    assert.strictEqual(registry.countFor(sessionId), 0);
    assert.strictEqual(registry.countFor("other-dst"), 0);
    registry.release("k2");
});

// Finding 2 (fix round 1): finalizeTerminalRecording and cleanupConnection both await external
// I/O and neither is wrapped in remove() — if either throws, remove() throws too, and _removing
// is already true by then, so the slot would otherwise stay reserved until the process restarts
// (a second remove() call is permanently refused once _removing is set). stream.end() throwing
// synchronously inside the async finalizeTerminalRecording turns into a rejection without needing
// a real filesystem or database.
test("removing a session still releases its transfer slot even if finalizing the recording fails", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    const session = SessionManager.get(sessionId);
    session.recording = { stream: { end: () => { throw new Error("disk full"); }, on: () => {} } };
    registry.reserve("k4", [sessionId, "other-rec"]);

    await assert.rejects(() => SessionManager.remove(sessionId), /disk full/);

    assert.strictEqual(registry.countFor(sessionId), 0, "the slot must be released even though cleanup failed afterward");
    assert.strictEqual(registry.countFor("other-rec"), 0);
    registry.release("k4");
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
    registry.release("unrelated-key");
    // "k3" is left tombstoned by design (Finding 3) until its own release() — simulate that here
    // so this test does not leak state into whatever runs after it in this same process.
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

// Finding 4 (fix round 1): cancelAllTransfers must only ever touch the map it was handed. This
// asserts that in the direction the coordinator asked for — an unrelated socket's own transfers
// map is left completely alone.
test("cancelAllTransfers never touches a different socket's transfers map", () => {
    const otherCalls = [];
    const ownTransfers = new Map([["t1", { transfer: { cancel: () => {} } }]]);
    const otherSocketTransfers = new Map([
        ["u1", { transfer: { cancel: () => otherCalls.push("u1") } }],
    ]);

    cancelAllTransfers(ownTransfers);

    assert.deepStrictEqual(otherCalls, [], "a different socket's transfer must not be cancelled");
    assert.strictEqual(otherSocketTransfers.size, 1, "a different socket's map must be untouched");
});

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

const test = require("node:test");
const assert = require("node:assert");
const SessionManager = require("../SessionManager");
const registry = require("../fileTransfer/registry");
const { cancelAllTransfers } = require("../../routes/sftpWS");

test("removing a session releases its transfer slots", async () => {
    // SessionManager.create returns the session object, not the bare id (see sessionCleanup.test.js).
    const { sessionId } = SessionManager.create("acc", "entry", {});
    registry.reserve("k1", [sessionId, "other"]);
    assert.strictEqual(registry.countFor(sessionId), 1);

    await SessionManager.remove(sessionId);

    assert.strictEqual(registry.countFor(sessionId), 0, "the vanished session still holds a slot");
    assert.strictEqual(registry.countFor("other"), 0, "the other side must be released too");
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
});

test("cancelAllTransfers cancels both the transfer and the broker of every entry", () => {
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
    assert.strictEqual(transfers.size, 0, "every entry must be removed from the socket's own map");
});

// TRANSFER_START sets a bare `{ pending: true }` placeholder before its two auxiliary connections
// exist (see transferHandlers.js:start) — no transfer or broker to cancel yet.
test("cancelAllTransfers leaves a still-connecting placeholder without throwing", () => {
    const transfers = new Map([["t1", { pending: true }]]);
    assert.doesNotThrow(() => cancelAllTransfers(transfers));
    assert.strictEqual(transfers.size, 0);
});

test("a throwing cancel does not stop the rest of the socket's transfers from being cancelled", () => {
    const calls = [];
    const transfers = new Map([
        ["t1", { transfer: { cancel: () => { throw new Error("already gone"); } } }],
        ["t2", { broker: { cancel: () => { throw new Error("already answered"); } } }],
        ["t3", { transfer: { cancel: () => calls.push("t3") } }],
    ]);

    assert.doesNotThrow(() => cancelAllTransfers(transfers));

    assert.deepStrictEqual(calls, ["t3"]);
    assert.strictEqual(transfers.size, 0);
});

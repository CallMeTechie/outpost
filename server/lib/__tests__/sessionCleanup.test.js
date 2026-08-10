const test = require("node:test");
const assert = require("node:assert");
const SessionManager = require("../SessionManager");
const { closeCrossTransferClients } = require("../SessionManager");
const controlPlane = require("../controlPlane/ControlPlaneServer");

test("closes every cross transfer client", () => {
    const closed = [];
    const conn = {
        crossTransferClients: new Map([
            ["t1", { client: { close: () => closed.push("t1") } }],
            ["t2", { client: { close: () => closed.push("t2") } }],
        ]),
    };

    closeCrossTransferClients(conn);

    assert.deepStrictEqual(closed.sort(), ["t1", "t2"]);
    assert.strictEqual(conn.crossTransferClients.size, 0);
});

test("a throwing client does not stop the others", () => {
    const closed = [];
    const conn = {
        crossTransferClients: new Map([
            ["t1", { client: { close: () => { throw new Error("already gone"); } } }],
            ["t2", { client: { close: () => closed.push("t2") } }],
        ]),
    };

    closeCrossTransferClients(conn);
    assert.deepStrictEqual(closed, ["t2"]);
});

test("a connection without cross transfer clients is fine", () => {
    assert.doesNotThrow(() => closeCrossTransferClients({}));
});

test("cross transfer clients are closed when session ends", async () => {
    const closed = [];
    const accountId = 123;
    const entryId = 456;

    const session = SessionManager.create(accountId, entryId, {});
    const sessionId = session.sessionId;

    const connection = {
        type: "ssh",
        crossTransferClients: new Map([
            ["transfer-1", { client: { close: () => closed.push("transfer-1") } }],
        ]),
    };

    SessionManager.setConnection(sessionId, connection);
    await SessionManager.remove(sessionId);

    assert.deepStrictEqual(closed, ["transfer-1"]);
});

// Fix round 3, Finding 3: this loop can be deleted without any prior test noticing (none of them
// populate conn.auxSessionIds), and it is exactly what registry.js's releaseSession comment leans
// on: a cross-transfer connection attempt still stuck in ConnectionService.js's
// getAuxiliarySFTPClient has its engine session id added to conn.auxSessionIds *before* the
// connection attempt starts, so closing every id here — not just the master session's own — is
// what force-closes that socket and lets the stuck attempt's promise finally settle.
test("auxiliary engine sessions are closed with the control plane when the session ends", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    const closedIds = [];
    const original = controlPlane.closeSession;
    controlPlane.closeSession = (id) => closedIds.push(id);
    try {
        SessionManager.setConnection(sessionId, {
            type: "ssh",
            auxSessionIds: new Set(["aux-1", "aux-2"]),
        });

        await SessionManager.remove(sessionId);

        assert.deepStrictEqual(closedIds.sort(), ["aux-1", "aux-2", sessionId].sort(),
            "every auxiliary engine session must be closed, not just the master session's own");
    } finally {
        controlPlane.closeSession = original;
    }
});

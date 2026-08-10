const test = require("node:test");
const assert = require("node:assert");
const SessionManager = require("../SessionManager");
const { closeCrossTransferClients } = require("../SessionManager");

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

const test = require("node:test");
const assert = require("node:assert");
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

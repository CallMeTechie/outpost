const test = require("node:test");
const assert = require("node:assert");
const { crossTransferKeys, releaseSFTPCrossTransferClient } = require("../ConnectionService");

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

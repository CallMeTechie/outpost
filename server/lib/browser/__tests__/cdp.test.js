const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { CdpConnection, CdpError } = require("../cdp");

const fakeSocket = () => Object.assign(new EventEmitter(), {
    sent: [],
    send(data) { this.sent.push(JSON.parse(data)); },
    close() { this.emit("close"); },
});

test("replies reach their caller by id, out of order, and protocol errors reject with their code", async () => {
    const socket = fakeSocket();
    const cdp = new CdpConnection(socket);
    const first = cdp.send("Page.navigate", { url: "https://a.test/" }, "S1");
    const second = cdp.send("Runtime.evaluate", { expression: "1" });
    assert.deepStrictEqual(socket.sent[0], { id: 1, method: "Page.navigate", params: { url: "https://a.test/" }, sessionId: "S1" });
    assert.deepStrictEqual(socket.sent[1], { id: 2, method: "Runtime.evaluate", params: { expression: "1" } });

    socket.emit("message", JSON.stringify({ id: 2, error: { code: -32000, message: "boom" } }));
    socket.emit("message", JSON.stringify({ id: 1, result: { frameId: "F" } }));

    assert.deepStrictEqual(await first, { frameId: "F" });
    await assert.rejects(second, (err) => err instanceof CdpError && err.code === -32000 && /Runtime\.evaluate: boom/.test(err.message));
});

test("events are emitted with the session they belong to", () => {
    const socket = fakeSocket();
    const cdp = new CdpConnection(socket);
    const events = [];
    cdp.on("event", (event) => events.push(event));
    socket.emit("message", JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S2" }));
    socket.emit("message", "not json");
    assert.deepStrictEqual(events, [{ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S2" }]);
});

test("a closed connection rejects every pending call and every later one", async () => {
    const socket = fakeSocket();
    const cdp = new CdpConnection(socket);
    let closed = false;
    cdp.on("close", () => { closed = true; });
    const pending = cdp.send("Page.enable");
    socket.emit("close");
    await assert.rejects(pending, /connection closed/);
    await assert.rejects(cdp.send("Page.enable"), /connection closed/);
    assert.ok(closed && cdp.closed);
});

const test = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const EngineSftpClient = require("../EngineSftpClient");

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.writableLength = 0;
    }
    write() { return true; }
    destroy() {}
}

const createClient = () => {
    const client = new EngineSftpClient(new FakeSocket());
    // Neutralise the protocol layer: this test only covers the _pending bookkeeping.
    client._buildAndSend = () => {};
    client._sendWriteData = () => {};
    return client;
};

// Drives writeFile up to the point where the data phase has begun.
const startDataPhase = async (client, source) => {
    const promise = client.writeFile("/tmp/x", source);
    await new Promise((r) => setImmediate(r));
    const [rid] = [...client._pending.keys()];
    client._resolvePending(rid, client._pending.get(rid));   // WriteBegin ack
    await new Promise((r) => setImmediate(r));
    return { promise, rid };
};

test("a pending entry exists during the data phase", async () => {
    const client = createClient();
    const source = new PassThrough();
    const { promise, rid } = await startDataPhase(client, source);

    assert.ok(client._pending.has(rid), "the data phase must keep a pending entry for the rid");

    // Never await the promise: after source.end() writeFile waits 120 s for a WriteEnd ack
    // that no one sends. Reject the placeholder instead so the promise settles immediately.
    client._pending.get(rid).reject(new Error("test teardown"));
    promise.catch(() => {});
});

test("an error frame during the data phase rejects writeFile with the server message", async () => {
    const client = createClient();
    const source = new PassThrough();
    const { promise, rid } = await startDataPhase(client, source);

    source.write(Buffer.from("some data"));
    client._pending.get(rid).reject(new Error("disk quota exceeded"));

    await assert.rejects(promise, /disk quota exceeded/);
});

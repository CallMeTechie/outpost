const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { writeAfterSettle } = require("../streamCommandWriter");

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.written = [];
    }

    write(chunk) {
        this.written.push(chunk);
        return true;
    }
}

test("writes nothing when there are no lines", async () => {
    const socket = new FakeSocket();
    const result = await writeAfterSettle(socket, [], { quietMs: 5, maxWaitMs: 20 });
    assert.strictEqual(result, false);
    assert.deepStrictEqual(socket.written, []);
});

test("writes after the stream goes quiet", async () => {
    const socket = new FakeSocket();
    const promise = writeAfterSettle(socket, ["cd '/srv'"], { quietMs: 20, maxWaitMs: 500 });

    socket.emit("data", Buffer.from("Welcome to Debian"));
    assert.deepStrictEqual(socket.written, [], "must not write while data is still arriving");

    const result = await promise;
    assert.strictEqual(result, true);
    assert.deepStrictEqual(socket.written, ["\ncd '/srv'\n"]);
});

test("restarts the quiet window on every chunk", async () => {
    const socket = new FakeSocket();
    const promise = writeAfterSettle(socket, ["echo ok"], { quietMs: 40, maxWaitMs: 2000 });

    socket.emit("data", Buffer.from("motd part 1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.emit("data", Buffer.from("motd part 2"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepStrictEqual(socket.written, [], "quiet window must have restarted");

    await promise;
    assert.deepStrictEqual(socket.written, ["\necho ok\n"]);
});

test("writes anyway when no data ever arrives", async () => {
    const socket = new FakeSocket();
    const result = await writeAfterSettle(socket, ["echo ok"], { quietMs: 1000, maxWaitMs: 30 });
    assert.strictEqual(result, true);
    assert.deepStrictEqual(socket.written, ["\necho ok\n"]);
});

test("writes multiple lines in order, in a single write", async () => {
    const socket = new FakeSocket();
    await writeAfterSettle(socket, ["cd '/srv'", "docker compose up -d"], { quietMs: 5, maxWaitMs: 20 });
    assert.deepStrictEqual(socket.written, ["\ncd '/srv'\ndocker compose up -d\n"]);
});

test("writes only once even if data keeps arriving afterwards", async () => {
    const socket = new FakeSocket();
    await writeAfterSettle(socket, ["echo ok"], { quietMs: 5, maxWaitMs: 20 });
    socket.emit("data", Buffer.from("late output"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(socket.written.length, 1);
});

test("resolves false if socket.write throws", async () => {
    class FakeSocketThrows extends EventEmitter {
        write(chunk) {
            throw new Error("Socket closed or destroyed");
        }
    }

    const socket = new FakeSocketThrows();
    const result = await writeAfterSettle(socket, ["echo ok"], { quietMs: 5, maxWaitMs: 20 });
    assert.strictEqual(result, false, "must resolve false when write fails");
});

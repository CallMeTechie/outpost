const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const { PassThrough } = require("node:stream");
const { createViaProxy, viaTargetFromUrl, hostResolverRule } = require("../proxy");
const { BrowserErrorCode } = require("../errors");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const connectClient = (port) => new Promise((resolve) => { const socket = net.connect(port, "127.0.0.1", () => resolve(socket)); });
const closed = (socket) => new Promise((resolve) => socket.once("close", resolve));
const waitFor = async (condition, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};
const roundTrip = (socket, text) => new Promise((resolve) => {
    socket.once("data", (data) => resolve(data.toString()));
    socket.write(text);
});

test("at most six channels are open at once; the seventh connection waits for a free one", async (t) => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    t.after(() => echo.close());

    let opened = 0;
    let peak = 0;
    const proxy = createViaProxy({
        allowedRemote: "127.0.0.1",
        host: "127.0.0.1",
        openChannel: async () => {
            opened++;
            peak = Math.max(peak, proxy.activeChannels);
            return net.connect(echoPort, "127.0.0.1");
        },
    });
    const port = await proxy.listen();
    t.after(() => proxy.close());

    const clients = [];
    for (let i = 0; i < 7; i++) clients.push(await connectClient(port));
    await waitFor(() => opened === 6);
    assert.strictEqual(proxy.activeChannels, 6);
    assert.strictEqual(await roundTrip(clients[0], "first"), "first");

    clients[0].destroy();
    await waitFor(() => opened === 7);
    assert.strictEqual(await roundTrip(clients[6], "seventh"), "seventh");
    assert.strictEqual(peak, 6);
    for (const client of clients) client.destroy();
});

test("connections from anywhere but the browser container are refused; a failed channel frees its slot", async (t) => {
    const strict = createViaProxy({ allowedRemote: "10.9.9.9", host: "127.0.0.1", openChannel: async () => { throw new Error("must not be called"); } });
    const strictPort = await strict.listen();
    t.after(() => strict.close());
    await closed(await connectClient(strictPort));

    let attempts = 0;
    const failing = createViaProxy({ allowedRemote: "127.0.0.1", host: "127.0.0.1", maxChannels: 1, openChannel: async () => { attempts++; throw new Error("engine down"); } });
    const port = await failing.listen();
    t.after(() => failing.close());
    const [a, b] = [await connectClient(port), await connectClient(port)];
    await Promise.all([closed(a), closed(b)]);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(failing.activeChannels, 0);
});

test("a request for a foreign host name is refused before a channel opens", async (t) => {
    let opened = 0;
    const proxy = createViaProxy({
        allowedRemote: "127.0.0.1",
        host: "127.0.0.1",
        expectHosts: new Set(["localhost:5173"]),
        openChannel: async () => {
            opened++;
            return new PassThrough();
        },
    });
    const port = await proxy.listen();
    t.after(() => proxy.close());

    const foreign = await connectClient(port);
    foreign.write("GET / HTTP/1.1\r\nHost: evil.test:40123\r\n\r\n");
    await closed(foreign);
    assert.strictEqual(opened, 0);

    const own = await connectClient(port);
    own.write("GET / HTTP/1.1\r\nHost: localhost:5173\r\n\r\n");
    await waitFor(() => opened === 1);
    own.destroy();
});

test("the resolver rule keeps the page's own address; IP literals are refused", () => {
    const target = viaTargetFromUrl("http://localhost:5173/app");
    assert.deepStrictEqual(target, { host: "localhost", port: 5173, remoteHost: "127.0.0.1" });
    assert.strictEqual(hostResolverRule(target, "outpost", 40123), "MAP localhost:5173 outpost:40123");
    assert.deepStrictEqual(viaTargetFromUrl("https://dev.internal/"), { host: "dev.internal", port: 443, remoteHost: "dev.internal" });
    for (const url of ["http://127.0.0.1:5173/", "http://[::1]:5173/"])
        assert.throws(() => viaTargetFromUrl(url), (err) => err.code === BrowserErrorCode.VIA_INVALID && /host name/.test(err.message), url);
    assert.throws(() => viaTargetFromUrl("http://localhost:9222/"), (err) => err.code === BrowserErrorCode.VIA_INVALID && /reserves/.test(err.message));
});

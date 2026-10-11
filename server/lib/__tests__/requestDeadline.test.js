const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { requestDeadline } = require("../../middlewares/requestDeadline");

const DEADLINE_MS = 200;
const drain = (req, res) => {
    req.resume();
    req.on("end", () => {
        if (!res.headersSent) res.end("done");
    });
};

const app = express();
app.use(requestDeadline({ ms: DEADLINE_MS }));
app.use(express.json());
app.post("/api/vault/git/cleared", (req, res, next) => {
    req.clearRequestDeadline();
    next();
}, drain);
app.post("/api/vault/git/kept", drain);
app.post("/api/vault/git/refused", (req, res) => res.status(401).json({ message: "no" }));
app.post("/api/entries", drain);
app.post("/api/slow", (req, res) => setTimeout(() => res.end("ok"), DEADLINE_MS * 2));

let server;

test.before(async () => {
    server = await new Promise((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
});

test.after(() => {
    server.closeAllConnections();
    server.close();
});

// Sends the body one byte at a time over trickleMs; settles on the response head, like a client
// that stops uploading once the server has answered.
const post = (path, { body = "x".repeat(12), trickleMs = 0, type = "application/octet-stream" } = {}) => new Promise((resolve, reject) => {
    const req = http.request({
        host: "127.0.0.1", port: server.address().port, path, method: "POST",
        headers: { "content-type": type, "content-length": Buffer.byteLength(body) },
    });
    const chunks = trickleMs > 0 ? [...body] : [body];
    const step = trickleMs / chunks.length;
    let timer = null;
    const sendNext = () => {
        req.write(chunks.shift());
        if (chunks.length === 0) req.end();
        else timer = setTimeout(sendNext, step);
    };
    req.on("response", (res) => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, connection: res.headers.connection });
        res.resume();
        res.on("end", () => req.destroy());
    });
    req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
    });
    sendNext();
});

// Keeps sending after the answer, like a slow-loris client; settles when the server closes the connection.
const uploadUntilClosed = (path, { giveUpMs }) => new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({
        host: "127.0.0.1", port: server.address().port, path, method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": 100000 },
    });
    let status = null;
    const sending = setInterval(() => req.write("x"), 20);
    const giveUp = setTimeout(() => req.destroy(), giveUpMs);
    req.on("response", (res) => {
        status = res.statusCode;
        res.resume();
    });
    req.on("socket", (socket) => socket.once("close", () => {
        clearInterval(sending);
        clearTimeout(giveUp);
        resolve({ status, closedAfterMs: Date.now() - started });
    }));
    req.on("error", () => {});
});

test("a body that has not arrived after the deadline ends with 408, also under /api/vault/git/ until the route lifts it; a slow answer to a complete body does not", async () => {
    const trickle = { trickleMs: DEADLINE_MS * 3 };

    assert.deepStrictEqual(await post("/api/entries", trickle), { status: 408, connection: "close" });
    assert.deepStrictEqual(await post("/api/vault/git/kept", trickle), { status: 408, connection: "close" }, "the git prefix alone lifts nothing");
    assert.strictEqual((await post("/api/vault/git/cleared", trickle)).status, 200, "clearRequestDeadline lets the upload run past the deadline");
    assert.strictEqual((await post("/api/slow")).status, 200,
        "a complete body is not cut off while the route takes its time");

    const refused = await uploadUntilClosed("/api/vault/git/refused", { giveUpMs: DEADLINE_MS * 10 });
    assert.strictEqual(refused.status, 401);
    assert.ok(refused.closedAfterMs < DEADLINE_MS * 3, `an answer without reading the body still ends the upload at the deadline (${refused.closedAfterMs} ms)`);
    const unrouted = await uploadUntilClosed("/api/nowhere", { giveUpMs: DEADLINE_MS * 10 });
    assert.deepStrictEqual([unrouted.status, unrouted.closedAfterMs < DEADLINE_MS * 3], [408, true],
        "finalhandler waits for the body of an unknown route; the deadline ends it without ERR_HTTP_HEADERS_SENT ending the process");
});

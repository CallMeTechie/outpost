const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const seen = [];
let reachedTool = () => {};
fake("../../../utils/permission", { hasAccountPermission: async () => true });
fake("../../browser", { getBrowserPool: () => ({}) });
fake("../../browser/tools", {
    createBrowserTools: () => ({
        list: () => [{ name: "browser_wait", description: "x", inputSchema: { type: "object", properties: {} } }],
        has: (name) => name === "browser_wait",
        call: async (name, args, ctx) => {
            seen.push(ctx);
            reachedTool();
            if (args.hang) await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
            return { content: [{ type: "text", text: "done" }] };
        },
        forgetTransport: () => {},
    }),
});

const router = require("../../../routes/mcp");

const listen = async (t) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { id: 7 };
        req.apiKey = { id: Number(req.header("x-test-key") ?? 3) };
        next();
    });
    app.use("/api/mcp", router);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return server;
};

const post = (server, body, headers = {}) => {
    const req = http.request({ port: server.address().port, path: "/api/mcp", method: "POST", headers: { "content-type": "application/json", ...headers } });
    const response = new Promise((resolve, reject) => {
        req.on("response", (res) => {
            let text = "";
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
        });
        req.on("error", reject);
    });
    req.end(JSON.stringify(body));
    return { req, response };
};

test("the tool's signal aborts when the client hangs up before the answer, and only then; another key cannot use the transport", { timeout: 2000 }, async (t) => {
    const server = await listen(t);
    const init = await post(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }).response;
    const headers = { "mcp-session-id": init.headers["mcp-session-id"] };

    const done = await post(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_wait", arguments: {} } }, headers).response;
    assert.strictEqual(done.body.result.content[0].text, "done");
    assert.strictEqual(seen[0].keyId, 3);
    assert.strictEqual(seen[0].signal.aborted, false);

    const foreign = await post(server, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_wait", arguments: {} } }, { ...headers, "x-test-key": "4" }).response;
    assert.strictEqual(foreign.status, 404);
    assert.strictEqual(foreign.body.error.code, -32001);
    assert.strictEqual(seen.length, 1);

    const reached = new Promise((resolve) => { reachedTool = resolve; });
    const hanging = post(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_wait", arguments: { hang: true } } }, headers);
    hanging.response.catch(() => {});
    await reached;
    hanging.req.destroy();
    await new Promise((resolve) => seen[1].signal.addEventListener("abort", resolve));
    assert.strictEqual(seen[1].signal.aborted, true);
    assert.strictEqual(seen[0].signal.aborted, false);
});

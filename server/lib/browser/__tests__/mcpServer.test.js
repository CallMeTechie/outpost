const test = require("node:test");
const assert = require("node:assert");
const { createMcpServer } = require("../mcpServer");

const fakeTools = () => {
    const calls = [];
    return {
        calls,
        list: () => [{ name: "browser_snapshot", description: "x", inputSchema: { type: "object", properties: {} } }],
        has: (name) => name === "browser_snapshot",
        call: async (name, args, ctx) => {
            calls.push({ name, args, ctx });
            return { content: [{ type: "text", text: "ok" }] };
        },
        forgetTransport: () => {},
    };
};

const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });

const handshake = async (mcp, accountId) => {
    const init = await mcp.handle({ body: rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } }), accountId });
    const transportId = init.headers["Mcp-Session-Id"];
    const ack = await mcp.handle({ body: { jsonrpc: "2.0", method: "notifications/initialized" }, transportId, accountId });
    return { init, transportId, ack };
};

test("the handshake opens a transport; a key without connect.browser sees no tools and cannot call one", async () => {
    const mcp = createMcpServer({ tools: fakeTools(), canUseBrowser: async (accountId) => accountId === 1 });
    const { init, transportId, ack } = await handshake(mcp, 1);
    assert.strictEqual(init.status, 200);
    assert.strictEqual(init.body.result.protocolVersion, "2025-06-18");
    assert.deepStrictEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    assert.match(transportId, /^[0-9a-f-]{36}$/);
    assert.strictEqual(ack.status, 202);
    const listed = await mcp.handle({ body: rpc(2, "tools/list"), transportId, accountId: 1 });
    assert.deepStrictEqual(listed.body.result.tools.map((t) => t.name), ["browser_snapshot"]);

    const other = await handshake(mcp, 2);
    const hidden = await mcp.handle({ body: rpc(2, "tools/list"), transportId: other.transportId, accountId: 2 });
    assert.deepStrictEqual(hidden.body.result.tools, []);
    const call = await mcp.handle({ body: rpc(3, "tools/call", { name: "browser_snapshot", arguments: {} }), transportId: other.transportId, accountId: 2 });
    assert.strictEqual(call.body.error.code, -32602);
});

test("an unknown transport or another account's gets 404, a missing header 400, and DELETE ends it", async () => {
    const mcp = createMcpServer({ tools: fakeTools(), canUseBrowser: async () => true });
    const { transportId } = await handshake(mcp, 1);
    assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), transportId: "nope", accountId: 1 })).status, 404);
    assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), transportId, accountId: 2 })).status, 404);
    assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), accountId: 1 })).status, 400);
    assert.strictEqual(mcp.end({ transportId, accountId: 1 }).status, 200);
    assert.strictEqual((await mcp.handle({ body: rpc(3, "tools/list"), transportId, accountId: 1 })).status, 404);
});

test("each transport reaches the tools under its own id", async () => {
    const tools = fakeTools();
    const mcp = createMcpServer({ tools, canUseBrowser: async () => true });
    const first = await handshake(mcp, 1);
    const second = await handshake(mcp, 1);
    assert.notStrictEqual(first.transportId, second.transportId);

    for (const { transportId } of [first, second])
        await mcp.handle({ body: rpc(9, "tools/call", { name: "browser_snapshot", arguments: { sessionId: "x" } }), transportId, accountId: 1, ipAddress: "10.0.0.1", userAgent: "ua" });

    assert.deepStrictEqual(tools.calls.map((c) => c.ctx.transportId), [first.transportId, second.transportId]);
    assert.deepStrictEqual(tools.calls[0].ctx, { accountId: 1, transportId: first.transportId, ipAddress: "10.0.0.1", userAgent: "ua" });
    assert.deepStrictEqual(tools.calls[0].args, { sessionId: "x" });
});

test("a request with \"params\": null is answered, not failed", async () => {
    const mcp = createMcpServer({ tools: fakeTools(), canUseBrowser: async () => true });
    const init = await mcp.handle({ body: { jsonrpc: "2.0", id: 1, method: "initialize", params: null }, accountId: 1 });
    assert.strictEqual(init.status, 200);
    assert.strictEqual(init.body.result.protocolVersion, "2025-06-18");
    const call = await mcp.handle({ body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: null }, transportId: init.headers["Mcp-Session-Id"], accountId: 1 });
    assert.strictEqual(call.body.error.code, -32602);
});

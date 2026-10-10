const test = require("node:test");
const assert = require("node:assert");
const { createMcpServer } = require("../server");

const fakeProvider = ({ name = "browser", tools = ["browser_snapshot"], available = async () => true } = {}) => {
    const calls = [];
    const forgotten = [];
    return {
        name,
        calls,
        forgotten,
        available,
        list: () => tools.map((tool) => ({ name: tool, description: "x", inputSchema: { type: "object", properties: {} } })),
        has: (tool) => tools.includes(tool),
        call: async (tool, args, ctx) => {
            calls.push({ tool, args, ctx });
            return { content: [{ type: "text", text: `${name} ok` }] };
        },
        forgetTransport: (transportId) => forgotten.push(transportId),
    };
};

const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });

const handshake = async (mcp, accountId, keyId = null) => {
    const init = await mcp.handle({ body: rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } }), accountId, keyId });
    const transportId = init.headers["Mcp-Session-Id"];
    const ack = await mcp.handle({ body: { jsonrpc: "2.0", method: "notifications/initialized" }, transportId, accountId, keyId });
    return { init, transportId, ack };
};

test("the handshake opens a transport; a caller whose only provider is unavailable sees no tools and cannot call one", async () => {
    const mcp = createMcpServer({ providers: [fakeProvider({ available: async (ctx) => ctx.accountId === 1 })] });
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
    const provider = fakeProvider();
    const mcp = createMcpServer({ providers: [provider] });
    const { transportId } = await handshake(mcp, 1);
    assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), transportId: "nope", accountId: 1 })).status, 404);
    assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), transportId, accountId: 2 })).status, 404);
    assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), accountId: 1 })).status, 400);
    assert.strictEqual(mcp.end({ transportId, accountId: 1 }).status, 200);
    assert.deepStrictEqual(provider.forgotten, [transportId]);
    assert.strictEqual((await mcp.handle({ body: rpc(3, "tools/list"), transportId, accountId: 1 })).status, 404);
});

test("a transport belongs to the key that opened it: another key of the same account gets 404, also on DELETE", async () => {
    const mcp = createMcpServer({ providers: [fakeProvider()] });
    const { transportId } = await handshake(mcp, 1, 5);

    for (const keyId of [6, null]) {
        assert.strictEqual((await mcp.handle({ body: rpc(2, "tools/list"), transportId, accountId: 1, keyId })).status, 404);
        assert.strictEqual(mcp.end({ transportId, accountId: 1, keyId }).status, 404);
    }
    for (let i = 0; i < 50; i++) await handshake(mcp, 1, 6);
    assert.strictEqual((await mcp.handle({ body: rpc(3, "ping"), transportId, accountId: 1, keyId: 5 })).status, 200);
    assert.strictEqual(mcp.end({ transportId, accountId: 1, keyId: 5 }).status, 200);
});

test("tools/list joins the available providers and tools/call answers a tool of an unavailable one as unknown", async () => {
    const browser = fakeProvider();
    const vault = fakeProvider({ name: "vault", tools: ["vault_list"], available: async (ctx) => ctx.keyId === 5 });
    const mcp = createMcpServer({ providers: [browser, vault] });
    const withVault = await handshake(mcp, 1, 5);
    const withoutVault = await handshake(mcp, 1, 6);

    const listed = await mcp.handle({ body: rpc(2, "tools/list"), transportId: withVault.transportId, accountId: 1, keyId: 5 });
    assert.deepStrictEqual(listed.body.result.tools.map((t) => t.name), ["browser_snapshot", "vault_list"]);
    const called = await mcp.handle({ body: rpc(3, "tools/call", { name: "vault_list", arguments: {} }), transportId: withVault.transportId, accountId: 1, keyId: 5 });
    assert.deepStrictEqual(called.body.result.content, [{ type: "text", text: "vault ok" }]);

    const refused = await mcp.handle({ body: rpc(4, "tools/call", { name: "vault_list", arguments: {} }), transportId: withoutVault.transportId, accountId: 1, keyId: 6 });
    assert.deepStrictEqual(refused.body.error, { code: -32602, message: "Unknown tool: vault_list" });
    assert.strictEqual(vault.calls.length, 1);
});

test("each transport reaches the providers under its own id with the full caller context", async () => {
    const provider = fakeProvider();
    const mcp = createMcpServer({ providers: [provider] });
    const first = await handshake(mcp, 1, 5);
    const second = await handshake(mcp, 1, 5);
    assert.notStrictEqual(first.transportId, second.transportId);

    const agent = { keyId: 5, entryId: 9, agentType: "claude" };
    const { signal } = new AbortController();
    for (const { transportId } of [first, second])
        await mcp.handle({ body: rpc(9, "tools/call", { name: "browser_snapshot", arguments: { sessionId: "x" } }), transportId, accountId: 1, keyId: 5, agent, impersonatorId: 2, ipAddress: "10.0.0.1", userAgent: "ua", signal });

    assert.deepStrictEqual(provider.calls.map((c) => c.ctx.transportId), [first.transportId, second.transportId]);
    assert.deepStrictEqual(provider.calls[0].ctx, { accountId: 1, agent, keyId: 5, impersonatorId: 2, transportId: first.transportId, ipAddress: "10.0.0.1", userAgent: "ua", signal });
    assert.deepStrictEqual(provider.calls[0].args, { sessionId: "x" });
});

test("a request with \"params\": null is answered, not failed", async () => {
    const mcp = createMcpServer({ providers: [fakeProvider()] });
    const init = await mcp.handle({ body: { jsonrpc: "2.0", id: 1, method: "initialize", params: null }, accountId: 1 });
    assert.strictEqual(init.status, 200);
    assert.strictEqual(init.body.result.protocolVersion, "2025-06-18");
    const call = await mcp.handle({ body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: null }, transportId: init.headers["Mcp-Session-Id"], accountId: 1 });
    assert.strictEqual(call.body.error.code, -32602);
});

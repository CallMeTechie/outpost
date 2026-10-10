const { randomUUID } = require("node:crypto");
const packageJson = require("../../../package.json");

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26"];
const TRANSPORT_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_TRANSPORTS_PER_CALLER = 50;

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const createMcpServer = ({ providers, now = Date.now }) => {
    const transports = new Map();

    const forget = (transportId) => {
        transports.delete(transportId);
        for (const provider of providers) provider.forgetTransport(transportId);
    };

    const sweep = () => {
        for (const [id, transport] of transports) {
            if (now() - transport.lastSeen > TRANSPORT_IDLE_MS) forget(id);
        }
    };

    const ownedBy = (transport, accountId, keyId) => !!transport && transport.accountId === accountId && transport.keyId === keyId;

    const availableProviders = async (ctx) => {
        const available = await Promise.all(providers.map((provider) => provider.available(ctx)));
        return providers.filter((_, index) => available[index]);
    };

    const handle = async ({ body, transportId, accountId, keyId = null, agent = null, impersonatorId = null, ipAddress = null, userAgent = null, signal }) => {
        if (agent && !(Number.isInteger(keyId) && Number.isInteger(agent.entryId)))
            throw new TypeError("An agent caller needs a numeric keyId and entryId");
        sweep();
        if (Array.isArray(body)) return { status: 400, body: rpcError(null, -32600, "Batched requests are not supported") };
        if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string")
            return { status: 400, body: rpcError(body?.id, -32600, "Invalid JSON-RPC request") };
        const { id, method } = body;
        const params = body.params ?? {};

        if (method === "initialize") {
            const own = [...transports].filter(([, t]) => ownedBy(t, accountId, keyId)).sort(([, a], [, b]) => a.lastSeen - b.lastSeen);
            for (const [oldId] of own.slice(0, Math.max(0, own.length - MAX_TRANSPORTS_PER_CALLER + 1))) forget(oldId);
            const newId = randomUUID();
            transports.set(newId, { accountId, keyId, lastSeen: now() });
            return {
                status: 200,
                headers: { "Mcp-Session-Id": newId },
                body: rpcResult(id, {
                    protocolVersion: SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "outpost", version: packageJson.version },
                }),
            };
        }

        const transport = transportId ? transports.get(transportId) : null;
        if (!ownedBy(transport, accountId, keyId)) {
            return transportId
                ? { status: 404, body: rpcError(id, -32001, "Unknown MCP session; initialize again") }
                : { status: 400, body: rpcError(id, -32600, "Missing Mcp-Session-Id header") };
        }
        transport.lastSeen = now();

        if (id === undefined) return { status: 202 };

        const ctx = { accountId, agent, keyId, impersonatorId, transportId, ipAddress, userAgent, signal };
        switch (method) {
            case "ping":
                return { status: 200, body: rpcResult(id, {}) };
            case "tools/list": {
                const tools = (await availableProviders(ctx)).flatMap((provider) => provider.list(ctx));
                return { status: 200, body: rpcResult(id, { tools }) };
            }
            case "tools/call": {
                const provider = (await availableProviders(ctx)).find((p) => p.has(params.name, ctx));
                if (!provider) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${params.name}`) };
                return { status: 200, body: rpcResult(id, await provider.call(params.name, params.arguments ?? {}, ctx)) };
            }
            default:
                return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
        }
    };

    const end = ({ transportId, accountId, keyId = null }) => {
        if (!ownedBy(transports.get(transportId), accountId, keyId)) return { status: 404 };
        forget(transportId);
        return { status: 200 };
    };

    return { handle, end };
};

module.exports = { createMcpServer };

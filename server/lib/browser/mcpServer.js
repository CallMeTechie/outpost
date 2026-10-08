const { randomUUID } = require("node:crypto");
const packageJson = require("../../../package.json");

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26"];
const TRANSPORT_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_TRANSPORTS_PER_ACCOUNT = 50;

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const createMcpServer = ({ tools, canUseBrowser, now = Date.now }) => {
    const transports = new Map();

    const sweep = () => {
        for (const [id, transport] of transports) {
            if (now() - transport.lastSeen <= TRANSPORT_IDLE_MS) continue;
            transports.delete(id);
            tools.forgetTransport(id);
        }
    };

    const handle = async ({ body, transportId, accountId, ipAddress = null, userAgent = null }) => {
        sweep();
        if (Array.isArray(body)) return { status: 400, body: rpcError(null, -32600, "Batched requests are not supported") };
        if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string")
            return { status: 400, body: rpcError(body?.id, -32600, "Invalid JSON-RPC request") };
        const { id, method, params = {} } = body;

        if (method === "initialize") {
            const own = [...transports].filter(([, t]) => t.accountId === accountId).sort(([, a], [, b]) => a.lastSeen - b.lastSeen);
            for (const [oldId] of own.slice(0, Math.max(0, own.length - MAX_TRANSPORTS_PER_ACCOUNT + 1))) {
                transports.delete(oldId);
                tools.forgetTransport(oldId);
            }
            const newId = randomUUID();
            transports.set(newId, { accountId, lastSeen: now() });
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
        if (!transport || transport.accountId !== accountId) {
            return transportId
                ? { status: 404, body: rpcError(id, -32001, "Unknown MCP session; initialize again") }
                : { status: 400, body: rpcError(id, -32600, "Missing Mcp-Session-Id header") };
        }
        transport.lastSeen = now();

        if (id === undefined) return { status: 202 };

        switch (method) {
            case "ping":
                return { status: 200, body: rpcResult(id, {}) };
            case "tools/list":
                return { status: 200, body: rpcResult(id, { tools: (await canUseBrowser(accountId)) ? tools.list() : [] }) };
            case "tools/call": {
                if (!(await canUseBrowser(accountId)) || !tools.has(params.name))
                    return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${params.name}`) };
                const ctx = { accountId, transportId, ipAddress, userAgent };
                return { status: 200, body: rpcResult(id, await tools.call(params.name, params.arguments ?? {}, ctx)) };
            }
            default:
                return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
        }
    };

    const end = ({ transportId, accountId }) => {
        const transport = transports.get(transportId);
        if (!transport || transport.accountId !== accountId) return { status: 404 };
        transports.delete(transportId);
        tools.forgetTransport(transportId);
        return { status: 200 };
    };

    return { handle, end };
};

module.exports = { createMcpServer };

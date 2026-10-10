const { Router } = require("express");
const { hasAccountPermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const { createMcpServer } = require("../lib/mcp/server");
const { createBrowserTools } = require("../lib/browser/tools");
const { getBrowserPool } = require("../lib/browser");
const logger = require("../utils/logger");

const browserTools = createBrowserTools({ getPool: getBrowserPool });
const browserProvider = {
    ...browserTools,
    name: "browser",
    available: (ctx) => hasAccountPermission(ctx.accountId, Permission.CONNECT_BROWSER),
};

const mcp = createMcpServer({ providers: [browserProvider] });

const callerOf = (req) => ({ accountId: req.user.id, keyId: req.apiKey?.id ?? null });

const app = Router();

const reply = (res, { status, headers = {}, body }) => {
    res.set(headers);
    if (body === undefined) return res.status(status).end();
    res.status(status).json(body);
};

/**
 * POST /mcp
 * @summary MCP Request
 * @description JSON-RPC 2.0 request of the Model Context Protocol over Streamable HTTP, without an SSE stream. `initialize` returns the transport id in the Mcp-Session-Id header; every later request carries it.
 * @tags MCP
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - JSON-RPC response
 * @return {object} 202 - Notification accepted
 * @return {object} 400 - Invalid request or missing Mcp-Session-Id header
 * @return {object} 404 - Unknown MCP session
 */
app.post("/", async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
        if (!res.writableEnded) controller.abort();
    });
    try {
        reply(res, await mcp.handle({
            body: req.body,
            transportId: req.header("mcp-session-id"),
            ...callerOf(req),
            agent: req.agent ?? null,
            impersonatorId: req.session?.impersonatorId ?? null,
            ipAddress: req.ip,
            userAgent: req.header("user-agent") ?? null,
            signal: controller.signal,
        }));
    } catch (err) {
        logger.error("MCP request failed", { error: err.message, method: req.body?.method });
        res.status(500).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32603, message: "Internal error" } });
    }
});

/**
 * DELETE /mcp
 * @summary End MCP Session
 * @description Ends the transport named in the Mcp-Session-Id header.
 * @tags MCP
 * @security BearerAuth
 * @return {object} 200 - Session ended
 * @return {object} 404 - Unknown MCP session
 */
app.delete("/", (req, res) => reply(res, mcp.end({ transportId: req.header("mcp-session-id"), ...callerOf(req) })));

/**
 * GET /mcp
 * @summary MCP Stream
 * @description This server opens no SSE stream and always answers 405.
 * @tags MCP
 * @security BearerAuth
 * @return {object} 405 - Method not allowed
 */
app.get("/", (req, res) => res.status(405).set("Allow", "POST, DELETE").end());

module.exports = app;

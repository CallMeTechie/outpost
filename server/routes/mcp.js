const { Router } = require("express");
const { hasAccountPermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const { createMcpServer } = require("../lib/browser/mcpServer");
const { createBrowserTools } = require("../lib/browser/tools");
const { getBrowserPool } = require("../lib/browser");

const mcp = createMcpServer({
    tools: createBrowserTools({ getPool: getBrowserPool }),
    canUseBrowser: (accountId) => hasAccountPermission(accountId, Permission.CONNECT_BROWSER),
});

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
    try {
        reply(res, await mcp.handle({
            body: req.body,
            transportId: req.header("mcp-session-id"),
            accountId: req.user.id,
            ipAddress: req.ip,
            userAgent: req.header("user-agent") ?? null,
        }));
    } catch (err) {
        res.status(500).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32603, message: err.message } });
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
app.delete("/", (req, res) => reply(res, mcp.end({ transportId: req.header("mcp-session-id"), accountId: req.user.id })));

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

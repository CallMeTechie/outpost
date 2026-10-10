const { Router } = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { authenticate } = require("../../middlewares/auth");
const { requireLoginSession } = require("../../middlewares/requireLoginSession");
const { requireVaultEnabled } = require("../../lib/vault/state");
const { validateSchema } = require("../../utils/schema");
const { sendError } = require("../../utils/error");
const logger = require("../../utils/logger");
const {
    createAgentKeysValidation, confirmAgentKeyValidation, listAgentKeysValidation, agentKeyIdValidation,
} = require("../../validations/vaultAgentKeys");
const { createAgentKeys, probe, confirm, revoke, listAgentKeys } = require("../../controllers/agentKeys");

const app = Router();

// Every setup runs several remote commands through the engine; the account bucket bounds that.
const agentKeyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => (req.user ? `acc:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many agent key changes. Please try again in a moment." },
    standardHeaders: true,
    legacyHeaders: false,
});

const probeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    keyGenerator: (req) => (req.apiKey ? `key:${req.apiKey.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many probes. Please try again in a moment." },
    standardHeaders: true,
    legacyHeaders: false,
});

const reply = (res, result, status = 200) => {
    if (result?.code) return sendError(res, result.code, result.code, result.message);
    res.status(status).json(result);
};

const requestContext = (req) => ({ ipAddress: req.ip, userAgent: req.headers["user-agent"] ?? null });

/**
 * GET /vault/agent-keys/probe
 * @summary Probe Agent Key Address
 * @description Called by the setup itself, with the pending agent key, from the server being set up. Answers with the address Outpost sees; only the first measurement is stored at the key. Any other caller gets 403.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - The seen address
 */
app.get("/agent-keys/probe", requireVaultEnabled, authenticate, probeLimiter, async (req, res) => {
    if (req.apiKey?.kind !== "agent" || !req.apiKey.pending)
        return sendError(res, 403, 403, "Only a pending agent key can probe");
    res.json(await probe(req.apiKey, req.ip));
});

/**
 * GET /vault/agent-keys
 * @summary List Agent Keys
 * @description Lists the confirmed agent keys of the account. With entryId only those of one server, plus the remote user and whether another account already set up a key for it.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} entryId.query - Server entry ID
 * @return {object} 200 - Agent keys
 */
app.get("/agent-keys", requireVaultEnabled, authenticate, async (req, res) => {
    const query = { ...req.query };
    if (validateSchema(res, listAgentKeysValidation, query)) return;
    reply(res, await listAgentKeys(req.user.id, { entryId: query.entryId ?? null }));
});

/**
 * POST /vault/agent-keys
 * @summary Set Up Agent Access
 * @description Creates one pending agent key per agent and sets it up on the server. The key is returned only inside a manual command, only in this response.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {CreateAgentKeys} request.body.required - Server, agents and IP binding
 * @return {object} 201 - Result per agent
 */
app.post("/agent-keys", requireVaultEnabled, authenticate, requireLoginSession, agentKeyLimiter, async (req, res) => {
    if (validateSchema(res, createAgentKeysValidation, req.body)) return;
    reply(res, await createAgentKeys({ accountId: req.user.id, ...req.body, ...requestContext(req) }), 201);
});

/**
 * POST /vault/agent-keys/{id}/confirm
 * @summary Confirm Agent Key
 * @description Makes a pending agent key final. With addSeenIp the address measured by the probe is added to the allowed ranges, once, only within 15 minutes of the setup and never when it is the address of the confirming browser. A pending key older than 15 minutes answers 410.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Agent key ID
 * @param {ConfirmAgentKey} request.body - Options
 * @return {object} 200 - Confirmation
 */
app.post("/agent-keys/:id/confirm", requireVaultEnabled, authenticate, requireLoginSession, agentKeyLimiter, async (req, res) => {
    const params = { ...req.params };
    if (validateSchema(res, agentKeyIdValidation, params)) return;
    const body = { ...(req.body ?? {}) };
    if (validateSchema(res, confirmAgentKeyValidation, body)) return;
    reply(res, await confirm(req.user.id, params.id, body, requestContext(req)));
});

/**
 * DELETE /vault/agent-keys/{id}
 * @summary Revoke Agent Key
 * @description Deletes the agent key, then removes the registration on the server if it still carries this key.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Agent key ID
 * @return {object} 200 - Revocation result
 */
app.delete("/agent-keys/:id", requireVaultEnabled, authenticate, requireLoginSession, agentKeyLimiter, async (req, res) => {
    const params = { ...req.params };
    if (validateSchema(res, agentKeyIdValidation, params)) return;
    reply(res, await revoke(req.user.id, params.id, requestContext(req)));
});

// Express 5 hands a rejected async handler to the error middleware, and server/index.js installs
// none - the built-in fallback answers with err.stack whenever NODE_ENV is not "production".
app.use((error, req, res, _next) => {
    logger.error("Agent key route failed", { path: req.originalUrl, error: error.message });
    sendError(res, 500, 500, "Could not complete the agent key request.");
});

module.exports = app;

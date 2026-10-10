const { Router } = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { authenticate } = require("../../middlewares/auth");
const { requireLoginSession } = require("../../middlewares/requireLoginSession");
const { requireVaultEnabled } = require("../../lib/vault/state");
const { answerApproval } = require("../../lib/vault/approvals");
const { VaultErrorMessage } = require("../../lib/vault/errors");
const { validateSchema } = require("../../utils/schema");
const { sendError } = require("../../utils/error");
const { answerVaultApprovalValidation } = require("../../validations/vaultApprovals");

const app = Router();

const answerLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    keyGenerator: (req) => (req.user ? `acc:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many approval answers. Please try again in a moment." },
    standardHeaders: true,
    legacyHeaders: false,
});

const MESSAGES = {
    404: "Approval request not found",
    409: "This approval request has already been answered",
    410: "This approval request has expired",
};

/**
 * POST /vault/approvals/{id}
 * @summary Answer Vault Approval
 * @description Answers an open approval request of the authenticated account: once allows exactly one fill, session allows the entry for the rest of the agent's MCP session, deny blocks the same caller for this entry for 60 seconds. Requires a signed-in session; API keys and impersonation sessions get 403.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {string} id.path.required - Approval request id
 * @param {AnswerVaultApproval} request.body.required - { decision: "once" | "session" | "deny" }
 * @return {object} 200 - { success: true }
 * @return {object} 400 - Invalid decision, or session for a request from an impersonation session (vault.session_not_allowed)
 * @return {object} 403 - Signed-in session required
 * @return {object} 404 - Unknown request or not owned by the account
 * @return {object} 409 - Already answered
 * @return {object} 410 - Expired or withdrawn
 */
app.post("/approvals/:id", authenticate, requireVaultEnabled, requireLoginSession, answerLimiter, (req, res) => {
    const body = req.body ?? {};
    if (validateSchema(res, answerVaultApprovalValidation, body)) return;
    const { status, code } = answerApproval(req.params.id, req.user.id, body.decision,
        { ipAddress: req.ip, userAgent: req.header("user-agent") ?? null });
    if (code) return sendError(res, status, code, VaultErrorMessage[code]);
    if (status !== 200) return sendError(res, status, status, MESSAGES[status]);
    res.json({ success: true });
});

module.exports = app;

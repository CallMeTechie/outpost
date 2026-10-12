const { Router } = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { authenticate } = require("../../middlewares/auth");
const { requireLoginSession } = require("../../middlewares/requireLoginSession");
const { requireVaultEnabled } = require("../../lib/vault/state");
const { validateSchema } = require("../../utils/schema");
const { sendError } = require("../../utils/error");
const { createVaultItemValidation } = require("../../validations/vault");
const {
    listItems, getItem, createItem, updateItem, deleteItem, revealSecret, forgetHostKey,
} = require("../../controllers/vaultItems");
const logger = require("../../utils/logger");

const app = Router();

const revealLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => (req.user ? `acc:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many reveals. Please try again in a minute." },
    standardHeaders: true,
    legacyHeaders: false,
});

const callerOf = (req) => ({
    accountId: req.user.id,
    impersonatorId: req.session?.impersonatorId ?? null,
    ipAddress: req.ip,
    userAgent: req.header("user-agent") ?? null,
    revealAllowed: !req.apiKey && !req.session?.impersonatorId,
});

const itemIdOf = (req) => (/^\d+$/.test(req.params.id) ? Number(req.params.id) : null);

const handle = (action, status = 200) => async (req, res) => {
    try {
        const result = await action(req, res);
        if (res.headersSent) return;
        if (result.code) return sendError(res, result.code, result.code, result.message);
        res.status(status).json(result);
    } catch (error) {
        logger.error("Vault request failed", { error: error.message });
        sendError(res, 500, 500, "Internal server error");
    }
};

/**
 * GET /vault/items
 * @summary List Vault Entries
 * @description Lists the vault entries the account owns (with vault.use) and those of organizations it is an active member of. Never contains secret values, only the names of the stored secret fields. SSH entries carry their remembered host keys (hostKeys).
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - { items }
 * @return {object} 404 - Vault is disabled
 */
app.get("/items", authenticate, requireVaultEnabled, handle((req) => listItems(callerOf(req))));

/**
 * GET /vault/items/{id}
 * @summary Get Vault Entry
 * @description One entry as in the list; SSH entries carry hostKeys: [{ target, algorithm, fingerprint, confirmedAt, confirmedBy: { id, name } | null }].
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Entry id
 * @return {object} 200 - { item }
 * @return {object} 404 - Unknown entry
 */
app.get("/items/:id", authenticate, requireVaultEnabled, handle((req) => getItem(callerOf(req), itemIdOf(req))));

/**
 * POST /vault/items
 * @summary Create Vault Entry
 * @description Creates a personal entry (vault.use) or an organization entry (vault.manage in that organization) with its secret values and server bindings.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {CreateVaultItem} request.body.required - The entry
 * @return {object} 201 - { item }
 * @return {object} 400 - Invalid input or binding
 * @return {object} 403 - Not allowed for this owner
 * @return {object} 409 - Name already taken for this owner
 */
app.post("/items", authenticate, requireVaultEnabled, handle((req, res) => {
    const body = req.body ?? {};
    if (validateSchema(res, createVaultItemValidation, body)) return null;
    return createItem(callerOf(req), body);
}, 201));

/**
 * PATCH /vault/items/{id}
 * @summary Update Vault Entry
 * @description Updates an entry. Changing its target (origins, hosts, host, fill origins or SSH servers) deletes all stored secret values in the same request; only values sent along are stored again. Removed SSH targets lose their remembered host key. New SSH servers need connect.ssh on that server, new free hosts connect.direct.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Entry id
 * @param {object} request.body.required - name, description, fields, secrets, approvalRequired, allServers, bindings
 * @return {object} 200 - { item, secretsCleared }
 * @return {object} 403 - Not allowed to manage this entry
 * @return {object} 404 - Unknown entry
 */
app.patch("/items/:id", authenticate, requireVaultEnabled, handle((req) => updateItem(callerOf(req), itemIdOf(req), req.body ?? {})));

/**
 * DELETE /vault/items/{id}
 * @summary Delete Vault Entry
 * @description Deletes an entry with its secret values and bindings.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Entry id
 * @return {object} 200 - { success: true }
 * @return {object} 403 - Not allowed to manage this entry
 * @return {object} 404 - Unknown entry
 */
app.delete("/items/:id", authenticate, requireVaultEnabled, handle((req) => deleteItem(callerOf(req), itemIdOf(req))));

/**
 * DELETE /vault/items/{id}/host-keys/{target}
 * @summary Forget SSH Host Key
 * @description Forgets the remembered host key of one target of an SSH entry; the next connection asks for approval with the new fingerprint. Same right as editing the entry.
 * @tags Vault
 * @security BearerAuth
 * @param {number} id.path.required - Entry id
 * @param {string} target.path.required - Target, URL-encoded: server:<entryId> or host:<host>[:<port>]
 * @return 204 - Forgotten
 * @return {object} 403 - Not allowed to manage this entry
 * @return {object} 404 - Unknown entry or no host key for this target
 */
app.delete("/items/:id/host-keys/:target", authenticate, requireVaultEnabled,
    handle((req) => forgetHostKey(callerOf(req), itemIdOf(req), req.params.target), 204));

/**
 * GET /vault/items/{id}/secrets/{field}
 * @summary Reveal Vault Secret
 * @description Returns one secret value. Owner of a personal entry or vault.reveal in the organization; signed-in session only (API keys and impersonation get 403). Every reveal is audited.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Entry id
 * @param {string} field.path.required - password, token, privateKey, passphrase or value
 * @return {object} 200 - { value }
 * @return {object} 403 - Not allowed to reveal
 * @return {object} 404 - Unknown entry or no value stored
 * @return {object} 422 - The value cannot be decrypted with the current vault key
 * @return {object} 429 - Too many reveals
 */
app.get("/items/:id/secrets/:field", authenticate, requireVaultEnabled, requireLoginSession, revealLimiter, handle((req, res) => {
    res.set("Cache-Control", "no-store");
    return revealSecret(callerOf(req), itemIdOf(req), req.params.field);
}));

module.exports = app;

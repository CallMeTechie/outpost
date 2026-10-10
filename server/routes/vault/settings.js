const { Router } = require("express");
const { authenticate } = require("../../middlewares/auth");
const { requirePermission } = require("../../middlewares/permission");
const { Permission } = require("../../permissions/registry");
const { validateSchema } = require("../../utils/schema");
const { sendError } = require("../../utils/error");
const { updateVaultSettingsValidation } = require("../../validations/vault");
const { getVaultSettings, updateVaultSettings, getVaultAvailability } = require("../../controllers/vaultSettings");
const logger = require("../../utils/logger");

const app = Router();

const trustProxyUnsafe = (req) => req.app.get("trust proxy") === true;

const failed = (res, error) => {
    logger.error("Vault settings request failed", { error: error.message });
    sendError(res, 500, 500, "Internal server error");
};

/**
 * GET /vault/available
 * @summary Vault Available
 * @description Whether the vault is on and what the account may do with it. Always answers 200, also while the vault is off; then every permission field is false or empty.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - { enabled, canUse, canManageOrgs, canProvision, agentUrlSet, impersonating, trustProxyUnsafe }
 */
app.get("/available", authenticate, async (req, res) => {
    try {
        res.json(await getVaultAvailability(req.user.id, {
            impersonating: Boolean(req.session?.impersonatorId), trustProxyUnsafe: trustProxyUnsafe(req),
        }));
    } catch (error) {
        failed(res, error);
    }
});

/**
 * GET /vault/settings
 * @summary Get Vault Settings
 * @description Status of VAULT_KEY and the Outpost address agents use. Answers while the vault is off, so the page can show why.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - { keyStatus, agentUrl, trustProxyUnsafe }
 * @return {object} 403 - Permission required
 */
app.get("/settings", authenticate, requirePermission(Permission.SETTINGS_VAULT), async (req, res) => {
    try {
        res.json({ ...(await getVaultSettings()), trustProxyUnsafe: trustProxyUnsafe(req) });
    } catch (error) {
        failed(res, error);
    }
});

/**
 * PATCH /vault/settings
 * @summary Update Vault Settings
 * @description Sets the Outpost address agents use (http or https; empty clears it). Works while the vault is off.
 * @tags Vault
 * @produces application/json
 * @security BearerAuth
 * @param {UpdateVaultSettings} request.body.required - { agentUrl }
 * @return {object} 200 - { keyStatus, agentUrl, trustProxyUnsafe }
 * @return {object} 400 - Invalid address
 * @return {object} 403 - Permission required
 */
app.patch("/settings", authenticate, requirePermission(Permission.SETTINGS_VAULT), async (req, res) => {
    try {
        const body = req.body ?? {};
        if (validateSchema(res, updateVaultSettingsValidation, body)) return;
        res.json({ ...(await updateVaultSettings(body)), trustProxyUnsafe: trustProxyUnsafe(req) });
    } catch (error) {
        failed(res, error);
    }
});

module.exports = app;

const { Router } = require("express");
const { requirePermission } = require("../middlewares/permission");
const { Permission } = require("../permissions/registry");
const { validateSchema } = require("../utils/schema");
const { updateBrowserSettingsValidation } = require("../validations/browser");
const { getBrowserSettings, updateBrowserSettings } = require("../controllers/browserSettings");
const { hasAccountPermission } = require("../utils/permission");
const { sendError } = require("../utils/error");
const { BrowserError, BrowserErrorCode } = require("../lib/browser/errors");
const { recordBrowserAudit, defaultAudit } = require("../lib/browser/tools");
const logger = require("../utils/logger");

const app = Router();

/**
 * GET /browser/settings
 * @summary Get Browser Settings
 * @description Retrieves the browser container configuration.
 * @tags Browser
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - Browser settings
 * @return {object} 403 - Permission required
 */
app.get("/settings", requirePermission(Permission.SETTINGS_BROWSER), async (req, res) => {
    try {
        res.json(await getBrowserSettings());
    } catch {
        res.status(500).json({ error: "Internal server error" });
    }
});

/**
 * PATCH /browser/settings
 * @summary Update Browser Settings
 * @description Updates the browser container configuration.
 * @tags Browser
 * @produces application/json
 * @security BearerAuth
 * @param {UpdateBrowserSettings} request.body.required - Updated browser settings
 * @return {object} 200 - Updated browser settings
 * @return {object} 403 - Permission required
 */
app.patch("/settings", requirePermission(Permission.SETTINGS_BROWSER), async (req, res) => {
    try {
        if (validateSchema(res, updateBrowserSettingsValidation, req.body)) return;
        res.json(await updateBrowserSettings(req.body));
    } catch {
        res.status(500).json({ error: "Internal server error" });
    }
});

/**
 * GET /browser/available
 * @summary Browser Tabs Available
 * @description Whether the authenticated account can open browser tabs: the feature is enabled and the account holds connect.browser.
 * @tags Browser
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - { enabled }
 */
app.get("/available", async (req, res) => {
    try {
        const enabled = (await getBrowserSettings()).enabled && await hasAccountPermission(req.user.id, Permission.CONNECT_BROWSER);
        res.json({ enabled });
    } catch {
        res.status(500).json({ error: "Internal server error" });
    }
});

const STATUS_BY_CODE = {
    [BrowserErrorCode.UNAVAILABLE]: 503,
    [BrowserErrorCode.LIMIT_REACHED]: 429,
};

/**
 * POST /browser/sessions
 * @summary Open Browser Session
 * @description Opens a new browser session on about:blank with the persistent profile of the authenticated account. The session belongs to the user, not to an agent.
 * @tags Browser
 * @produces application/json
 * @security BearerAuth
 * @return {object} 201 - The session
 * @return {object} 403 - Permission required
 * @return {object} 429 - Session limit reached
 * @return {object} 503 - Browser tabs are not enabled or the container is unreachable
 */
app.post("/sessions", requirePermission(Permission.CONNECT_BROWSER), async (req, res) => {
    try {
        const { session } = await require("../lib/browser").getBrowserPool().open({
            accountId: req.user.id, url: null, profile: "persistent", origin: "user",
        });
        await recordBrowserAudit(defaultAudit, { accountId: req.user.id, ipAddress: req.ip, userAgent: req.header("user-agent") ?? null },
            session, "browser.open", { tool: null, via: null });
        res.status(201).json(session.summary());
    } catch (err) {
        if (err instanceof BrowserError) {
            const status = STATUS_BY_CODE[err.code] ?? 400;
            return sendError(res, status, status, err.message);
        }
        logger.error("Opening a browser session failed", { error: err.message });
        sendError(res, 500, 500, "Internal server error");
    }
});

module.exports = app;

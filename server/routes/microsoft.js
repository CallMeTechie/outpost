const { Router } = require("express");
const { authenticate } = require("../middlewares/auth");
const { requirePermission } = require("../middlewares/permission");
const { Permission } = require("../permissions/registry");
const { validateSchema } = require("../utils/schema");
const {
    microsoftAppValidation, microsoftConnectValidation, microsoftRenameValidation,
} = require("../validations/microsoft");
const { renderCallbackPage } = require("../lib/microsoft/callbackPage");
const microsoft = require("../controllers/microsoftAuth");
const logger = require("../utils/logger");

const app = Router();

/**
 * POST /microsoft/connections/start
 * @summary Start connecting a Microsoft account
 * @description Creates a pending sign-in bound to the authenticated account and returns the URL the browser has to open.
 * @tags Microsoft
 * @produces application/json
 * @security BearerAuth
 * @param {object} request.body - Optional flag allFiles to request Files.ReadWrite.All
 * @return {object} 200 - The Microsoft authorization URL
 */
app.post("/connections/start", authenticate, async (req, res) => {
    if (validateSchema(res, microsoftConnectValidation, req.body ?? {})) return;

    try {
        res.json(await microsoft.startConnect(req.user.id, { allFiles: req.body?.allFiles === true }));
    } catch (error) {
        if (error.kind === "temporary") return res.status(503).json({ message: error.message });

        logger.error("Failed to start the Microsoft sign-in", { error: error.message });
        res.status(500).json({ message: "Failed to start the Microsoft sign-in" });
    }
});

/**
 * GET /microsoft/callback
 * @summary Microsoft OAuth callback
 * @description Handles the redirect from Microsoft and renders a page that reports the result to the opening window. Deliberately unauthenticated — the request carries no session, so the account is taken from the stored sign-in state.
 * @tags Microsoft
 * @produces text/html
 * @return {string} 200 - A page that closes itself
 */
app.get("/callback", async (req, res) => {
    let result;
    try {
        result = await microsoft.handleCallback(req.query);
    } catch (error) {
        logger.error("Microsoft callback failed", { error: error.message });
        result = { status: "error", reason: "exchange_failed" };
    }

    res.set("Content-Type", "text/html; charset=utf-8").send(renderCallbackPage(result));
});

/**
 * GET /microsoft/connections
 * @summary List connected Microsoft accounts
 * @tags Microsoft
 * @produces application/json
 * @security BearerAuth
 * @return {array} 200 - The connections of the authenticated account
 */
app.get("/connections", authenticate, async (req, res) => {
    res.json(await microsoft.listConnections(req.user.id));
});

/**
 * PATCH /microsoft/connections/{id}
 * @summary Rename a connected Microsoft account
 * @tags Microsoft
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Connection ID
 * @return {object} 200 - The updated connection
 */
app.patch("/connections/:id", authenticate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid connection ID" });
    if (validateSchema(res, microsoftRenameValidation, req.body ?? {})) return;

    const result = await microsoft.renameConnection(req.user.id, id, req.body.displayName);
    if (result?.code) return res.status(result.code).json({ message: result.message });

    res.json(result);
});

/**
 * DELETE /microsoft/connections/{id}
 * @summary Disconnect a Microsoft account
 * @tags Microsoft
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Connection ID
 * @return {object} 200 - Deletion confirmation
 */
app.delete("/connections/:id", authenticate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid connection ID" });

    const result = await microsoft.deleteConnection(req.user.id, id);
    if (result?.code) return res.status(result.code).json({ message: result.message });

    res.json(result);
});

/**
 * GET /microsoft/app
 * @summary Get the Azure app registration
 * @description Returns the registration with the client secret masked.
 * @tags Microsoft
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - The registration, or null when none exists
 */
app.get("/app", authenticate, requirePermission(Permission.SETTINGS_MICROSOFT), async (req, res) => {
    res.json(await microsoft.getApp());
});

/**
 * PUT /microsoft/app
 * @summary Create or replace the Azure app registration
 * @tags Microsoft
 * @produces application/json
 * @security BearerAuth
 * @param {object} request.body.required - clientId, clientSecret, redirectUri, enabled
 * @return {object} 200 - The stored registration with the secret masked
 */
app.put("/app", authenticate, requirePermission(Permission.SETTINGS_MICROSOFT), async (req, res) => {
    if (validateSchema(res, microsoftAppValidation, req.body ?? {})) return;

    const result = await microsoft.saveApp(req.body);
    if (result?.code) return res.status(result.code).json({ message: result.message });

    res.json(result);
});

/**
 * DELETE /microsoft/app
 * @summary Remove the Azure app registration
 * @tags Microsoft
 * @produces application/json
 * @security BearerAuth
 * @return {object} 200 - Deletion confirmation
 */
app.delete("/app", authenticate, requirePermission(Permission.SETTINGS_MICROSOFT), async (req, res) => {
    res.json(await microsoft.deleteApp());
});

module.exports = app;

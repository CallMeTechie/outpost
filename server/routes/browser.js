const { Router } = require("express");
const { requirePermission } = require("../middlewares/permission");
const { Permission } = require("../permissions/registry");
const { validateSchema } = require("../utils/schema");
const { updateBrowserSettingsValidation } = require("../validations/browser");
const { getBrowserSettings, updateBrowserSettings } = require("../controllers/browserSettings");

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

module.exports = app;

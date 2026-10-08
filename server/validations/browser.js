const Joi = require("joi");

module.exports.updateBrowserSettingsValidation = Joi.object({
    enabled: Joi.boolean(),
    launcherUrl: Joi.string().uri({ scheme: ["http", "https"] }),
    callbackHost: Joi.string().hostname(),
    maxSessions: Joi.number().integer().min(1).max(32),
    idleMinutes: Joi.number().integer().min(1).max(1440),
}).min(1);

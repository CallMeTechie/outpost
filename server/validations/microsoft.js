const Joi = require("joi");

module.exports.microsoftAppValidation = Joi.object({
    clientId: Joi.string().min(1).max(200).required(),
    clientSecret: Joi.string().allow("", null),
    redirectUri: Joi.string().uri().required(),
    enabled: Joi.boolean().default(false),
});

module.exports.microsoftConnectValidation = Joi.object({
    allFiles: Joi.boolean().default(false),
});

module.exports.microsoftRenameValidation = Joi.object({
    displayName: Joi.string().min(1).max(64).required(),
});

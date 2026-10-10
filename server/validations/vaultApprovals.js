const Joi = require("joi");

module.exports.answerVaultApprovalValidation = Joi.object({
    decision: Joi.string().valid("once", "session", "deny").required(),
});

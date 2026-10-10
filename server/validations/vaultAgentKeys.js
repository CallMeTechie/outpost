const net = require("node:net");
const Joi = require("joi");
const { agentUrl } = require("./vault");

const cidr = Joi.string().trim().max(64).custom((value, helpers) => {
    const [address, bits, ...rest] = value.split("/");
    const family = net.isIP(address);
    const max = family === 6 ? 128 : 32;
    if (!family || rest.length > 0) return helpers.error("any.invalid");
    if (bits === undefined) return `${address}/${max}`;
    if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return helpers.error("any.invalid");
    return `${address}/${Number(bits)}`;
}).messages({ "any.invalid": "{{#label}} must be an IP address or a CIDR range" });

module.exports.createAgentKeysValidation = Joi.object({
    entryId: Joi.number().integer().positive().required(),
    agentTypes: Joi.array().items(Joi.string().valid("claude", "codex")).min(1).unique().required(),
    agentUrl: agentUrl.allow(null, ""),
    ipBinding: Joi.boolean(),
    allowedCidrs: Joi.array().items(cidr).max(16).unique().default([]),
});

module.exports.confirmAgentKeyValidation = Joi.object({
    addSeenIp: Joi.boolean().default(false),
});

module.exports.listAgentKeysValidation = Joi.object({
    entryId: Joi.number().integer().positive(),
});

module.exports.agentKeyIdValidation = Joi.object({
    id: Joi.number().integer().positive().required(),
});

const Joi = require("joi");

// Either a stored entry or a one-off target, never both and never neither.
// The direct path skips per-entry access rules by construction, so it is gated
// on its own permission in the controller (connect.direct, off by default).
module.exports.createSessionValidation = Joi.object({
    entryId: Joi.number().optional(),
    directTarget: Joi.object({
        // A hostname or an IP. No scheme, no path, no credentials in the string:
        // those belong in directIdentity, and a URL-shaped host is a sign
        // something is being smuggled.
        host: Joi.string().max(255).pattern(/^[A-Za-z0-9._:-]+$/).required(),
        port: Joi.number().integer().min(1).max(65535).required(),
        protocol: Joi.string().valid("ssh", "telnet").required(),
    }).optional(),
    identityId: Joi.number().allow(null).optional(),
    connectionReason: Joi.string().allow(null, '').optional(),
    type: Joi.string().allow(null).optional(),
    tabId: Joi.string().allow(null).optional(),
    browserId: Joi.string().allow(null).optional(),
    scriptId: Joi.number().allow(null).optional(),
    startPath: Joi.string().allow(null).optional(),
    tmuxCreate: Joi.boolean().optional(),
    tmuxSession: Joi.when("tmuxCreate", {
        is: true,
        then: Joi.string().pattern(/^[A-Za-z0-9_-]{1,64}$/).required(),
        otherwise: Joi.string().max(128).pattern(/^[^\x00-\x1F\x7F]+$/).allow(null).optional(),
    }),
    // tmux window ids come straight from tmux ("@" plus digits) - this only
    // checks the shape. The server separately requires the id to appear in a
    // freshly fetched listing before it is used for anything.
    tmuxWindowId: Joi.string().pattern(/^@[0-9]{1,10}$/).allow(null).optional(),
    directIdentity: Joi.object({
        username: Joi.string().max(255).optional(),
        type: Joi.string().valid("password", "ssh", "both", "password-only").required(),
        password: Joi.string().optional(),
        sshKey: Joi.string().optional(),
        passphrase: Joi.string().optional(),
    }).optional()
})
    .xor("entryId", "directTarget")
    // A one-off target has no stored identity to point at, and no script or
    // saved tmux session belongs to it either.
    .with("directTarget", "directIdentity")
    .without("directTarget", ["identityId", "scriptId", "tmuxSession", "tmuxCreate", "tmuxWindowId"]);

module.exports.sessionIdValidation = Joi.object({
    id: Joi.string().uuid().required()
});

module.exports.resumeSessionValidation = Joi.object({
    tabId: Joi.string().allow(null).optional(),
    browserId: Joi.string().allow(null).optional()
});

module.exports.duplicateSessionValidation = Joi.object({
    tabId: Joi.string().allow(null).optional(),
    browserId: Joi.string().allow(null).optional()
});

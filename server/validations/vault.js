const Joi = require("joi");

const TYPES = ["login", "api_key", "ssh", "database", "generic"];

const SECRET_FIELDS = Object.freeze({
    login: ["password"],
    api_key: ["token"],
    ssh: ["privateKey", "password", "passphrase"],
    database: ["password"],
    generic: ["value"],
});
const SECRET_MAX_LENGTH = { password: 4096, token: 8192, privateKey: 16384, passphrase: 4096, value: 65536 };

const name = Joi.string().pattern(/^[a-z0-9][a-z0-9._-]{0,63}$/)
    .messages({ "string.pattern.base": "name may only contain lowercase letters, digits, dot, dash and underscore (max. 64)" });
const description = Joi.string().max(2000).allow("", null);

// Only scheme, host and port: a path, credentials or a query would never match the frame origin
// browser_fill_credential compares against, and new URL().origin lowercases and drops default ports.
const origin = Joi.string().max(2048).custom((value, helpers) => {
    if (!/^https?:\/\/[^/?#@\s]+$/i.test(value)) return helpers.error("any.invalid");
    try {
        return new URL(value).origin;
    } catch {
        return helpers.error("any.invalid");
    }
}).messages({ "any.invalid": "origins must look like https://host[:port]" });

const FIELDS = {
    login: Joi.object({
        username: Joi.string().max(255).allow(""),
        origins: Joi.array().items(origin).min(1).max(20).required(),
    }),
    api_key: Joi.object({
        hosts: Joi.array().items(Joi.string().hostname()).min(1).max(20).required(),
        headerName: Joi.string().pattern(/^[A-Za-z0-9-]{1,64}$/).default("Authorization"),
        headerTemplate: Joi.string().max(512).pattern(/\{\{secret\}\}/).default("Bearer {{secret}}"),
    }),
    ssh: Joi.object({
        username: Joi.string().max(255).required(),
    }),
    database: Joi.object({
        engine: Joi.string().valid("postgres", "mysql", "sqlite").required(),
        host: Joi.string().hostname().when("engine", { is: "sqlite", then: Joi.optional(), otherwise: Joi.required() }),
        port: Joi.number().integer().min(1).max(65535),
        database: Joi.string().max(1024).required(),
        username: Joi.string().max(255),
    }),
    generic: Joi.object({}),
};

const secretsOf = (type) => Joi.object(Object.fromEntries(
    SECRET_FIELDS[type].map((field) => [field, Joi.string().min(1).max(SECRET_MAX_LENGTH[field])]),
));

const CREATE_SECRETS = {
    login: secretsOf("login").fork(["password"], (schema) => schema.required()).required(),
    api_key: secretsOf("api_key").fork(["token"], (schema) => schema.required()).required(),
    ssh: secretsOf("ssh").or("privateKey", "password").required(),
    database: secretsOf("database").default({}),
    generic: secretsOf("generic").fork(["value"], (schema) => schema.required()).required(),
};

const CREATE_FIELDS = {
    login: FIELDS.login.required(),
    api_key: FIELDS.api_key.required(),
    ssh: FIELDS.ssh.required(),
    database: FIELDS.database.required(),
    generic: FIELDS.generic.default({}),
};

const byType = (schemas) => Joi.when("type", { switch: TYPES.map((type) => ({ is: type, then: schemas[type] })) });

const bindings = Joi.array().items(Joi.object({
    kind: Joi.string().valid("entry", "folder", "tag").required(),
    targetId: Joi.number().integer().positive().required(),
})).max(200);

module.exports.SECRET_FIELDS = SECRET_FIELDS;

module.exports.createVaultItemValidation = Joi.object({
    organizationId: Joi.number().integer().positive().allow(null).default(null),
    name: name.required(),
    type: Joi.string().valid(...TYPES).required(),
    description,
    fields: byType(CREATE_FIELDS),
    secrets: byType(CREATE_SECRETS),
    approvalRequired: Joi.boolean().default(true),
    allServers: Joi.boolean().default(false),
    bindings: bindings.default([]),
});

module.exports.updateVaultItemSchema = (type) => Joi.object({
    name,
    description,
    fields: FIELDS[type],
    secrets: secretsOf(type),
    approvalRequired: Joi.boolean(),
    allServers: Joi.boolean(),
    bindings,
}).min(1);

const agentUrl = Joi.string().max(2048).custom((value, helpers) => {
    let url;
    try {
        url = new URL(value);
    } catch {
        return helpers.error("any.invalid");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        return helpers.error("any.invalid");
    return url.origin + url.pathname.replace(/\/+$/, "");
}).messages({ "any.invalid": "agentUrl must be an http or https address without credentials, query or fragment" });

module.exports.agentUrl = agentUrl;

module.exports.updateVaultSettingsValidation = Joi.object({
    agentUrl: agentUrl.allow(null, ""),
    ipBindingDefault: Joi.boolean(),
}).min(1);

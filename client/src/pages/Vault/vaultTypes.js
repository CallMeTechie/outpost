import { LogIn as IconLogIn, KeyRound as IconKeyRound, SquareTerminal as IconSquareTerminal, Database as IconDatabase, Lock as IconLock } from "lucide-react";

export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const DB_ENGINES = [
    { value: "postgres", label: "PostgreSQL" },
    { value: "mysql", label: "MySQL" },
    { value: "sqlite", label: "SQLite" },
];

// `targets` are the fields whose change makes the server drop every stored secret of the item.
export const VAULT_TYPES = {
    login: {
        labelKey: "vault.types.login", icon: IconLogIn, secrets: ["password"], targets: ["origins"],
        defaults: { username: "", origins: "" },
    },
    api_key: {
        labelKey: "vault.types.apiKey", icon: IconKeyRound, secrets: ["token"], targets: ["hosts"],
        defaults: {
            hosts: "", headerName: "Authorization", headerTemplate: "Bearer {{secret}}",
            readOnly: false, allowHttp: false, git: false, gitUsername: "x-access-token", fillOrigins: "",
        },
    },
    ssh: {
        labelKey: "vault.types.ssh", icon: IconSquareTerminal, secrets: ["privateKey", "password", "passphrase"], targets: [],
        defaults: { username: "" },
    },
    database: {
        labelKey: "vault.types.database", icon: IconDatabase, secrets: ["password"], targets: ["host"],
        defaults: { engine: "postgres", host: "", port: "", database: "", username: "" },
    },
    generic: { labelKey: "vault.types.other", icon: IconLock, secrets: ["value"], targets: [], defaults: { fillOrigins: "" } },
};

export const TYPE_KEYS = Object.keys(VAULT_TYPES);

export const USAGE_FIELDS = ["readOnly", "allowHttp", "git", "gitUsername", "fillOrigins"];

const LIST_FIELDS = ["origins", "hosts", "fillOrigins"];

// Mirrors the required fields of Task 5 (`FIELDS` in server/validations/vault.js); the server stays authoritative.
const REQUIRED_FIELDS = {
    login: ["origins"], api_key: ["hosts"], ssh: ["username"], database: ["engine", "host", "database"], generic: [],
};

export const ownerKey = (item) => (item.organizationId ? `org-${item.organizationId}` : "personal");

// A database password is optional: SQLite has none, and the server accepts a database entry without one.
export const isSecretMissing = (type, values) => {
    if (type === "database") return false;
    if (type === "ssh") return !values.privateKey && !values.password;
    return VAULT_TYPES[type].secrets.some((field) => !values[field]);
};

export const missingFields = (type, payloadFields) => REQUIRED_FIELDS[type].filter((field) => {
    if (field === "host" && payloadFields.engine === "sqlite") return false;
    const value = payloadFields[field];
    return Array.isArray(value) ? value.length === 0 : value === undefined;
});

export const toFormFields = (type, fields = {}) => {
    const { defaults } = VAULT_TYPES[type];
    return Object.fromEntries(Object.entries({ ...defaults, ...fields })
        .filter(([key]) => key in defaults)
        .map(([key, value]) => {
            if (typeof defaults[key] === "boolean") return [key, value === true];
            return [key, Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value)];
        }));
};

const splitList = (value) => value.split(/[\s,]+/).filter(Boolean);

export const toPayloadFields = (formFields) => Object.fromEntries(Object.entries(formFields).flatMap(([key, value]) => {
    if (typeof value === "boolean") return [[key, value]];
    if (LIST_FIELDS.includes(key)) return [[key, splitList(value)]];
    if (key === "gitUsername" && !formFields.git) return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    return [[key, key === "port" ? Number(trimmed) : trimmed]];
}));

const isOrigin = (value) => {
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
            && url.pathname === "/" && !url.search && !url.hash;
    } catch {
        return false;
    }
};

export const usageProblems = (formFields) => ({
    gitUsername: formFields.git === true && !formFields.gitUsername.trim(),
    fillOrigins: typeof formFields.fillOrigins === "string" && splitList(formFields.fillOrigins).some((origin) => !isOrigin(origin)),
});

const hostOf = (origin) => {
    try {
        return new URL(origin).host;
    } catch {
        return origin;
    }
};

export const itemSubject = ({ type, fields = {} }) => {
    const joined = (user, host) => [user, host].filter(Boolean).join("@");
    if (type === "login") return joined(fields.username, fields.origins?.[0] && hostOf(fields.origins[0]));
    if (type === "api_key") return fields.hosts?.[0] || "";
    if (type === "database") return joined(fields.username, fields.host);
    if (type === "ssh") return fields.username || "";
    return "";
};

export const matchesSearch = (item, term) => {
    const needle = term.trim().toLowerCase();
    if (!needle) return true;
    const { username, host, hosts = [], origins = [] } = item.fields || {};
    return [item.name, item.description, username, host, ...hosts, ...origins]
        .some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
};

export const detailRows = ({ type, fields = {} }) => {
    const rows = {
        login: [["vault.fields.username", fields.username], ["vault.fields.origins", fields.origins?.join(", ")]],
        api_key: [["vault.fields.hosts", fields.hosts?.join(", ")],
            ["vault.fields.header", fields.headerName && `${fields.headerName}: ${fields.headerTemplate || ""}`]],
        ssh: [["vault.fields.username", fields.username]],
        database: [["vault.fields.engine", DB_ENGINES.find((engine) => engine.value === fields.engine)?.label],
            ["vault.fields.host", fields.host], ["vault.fields.port", fields.port],
            ["vault.fields.database", fields.database], ["vault.fields.username", fields.username]],
    }[type] || [];
    return rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
};

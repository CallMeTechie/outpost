const test = require("node:test");
const assert = require("node:assert");
const {
    createVaultItemValidation, updateVaultItemSchema, updateVaultSettingsValidation,
} = require("../../../validations/vault");

const validate = (schema, value) => schema.validate(value, { allowUnknown: false });

const login = (overrides = {}) => ({
    name: "portal-login", type: "login",
    fields: { username: "ma", origins: ["https://portal.example.com"] },
    secrets: { password: "pw" },
    ...overrides,
});
const apiKey = (fields) => ({ name: "gh", type: "api_key", fields: { hosts: ["api.github.com"], ...fields }, secrets: { token: "t" } });

test("Einträge, Änderungen und Einstellungen werden je Typ per Whitelist geprüft und Ursprünge normalisiert", () => {
    const accepted = [
        [login({ fields: { username: "ma", origins: ["HTTPS://Portal.Example.com:443", "http://10.0.0.5:8080"] } }),
            (value) => assert.deepStrictEqual(value.fields.origins, ["https://portal.example.com", "http://10.0.0.5:8080"])],
        [{ name: "gh.token_1", type: "api_key", fields: { hosts: ["api.github.com"] }, secrets: { token: "t" } },
            (value) => assert.deepStrictEqual(
                [value.fields.headerName, value.fields.headerTemplate, value.organizationId, value.approvalRequired, value.allServers, value.bindings],
                ["Authorization", "Bearer {{secret}}", null, true, false, []])],
        [{ name: "nas-root", type: "ssh", fields: { username: "root" }, secrets: { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----" } }],
        [{ name: "local-db", type: "database", fields: { engine: "sqlite", database: "/data/app.db" } },
            (value) => assert.deepStrictEqual(value.secrets, {})],
        [{ name: "misc", type: "generic", secrets: { value: "x" }, organizationId: 20, bindings: [{ kind: "folder", targetId: 3 }] },
            (value) => assert.deepStrictEqual(value.fields, {})],
    ];
    for (const [input, check] of accepted) {
        const { error, value } = validate(createVaultItemValidation, input);
        assert.strictEqual(error, undefined, `${input.name}: ${error?.message}`);
        check?.(value);
    }

    const rejected = [
        ["Ursprung mit Pfad", login({ fields: { origins: ["https://portal.example.com/login"] } })],
        ["Ursprung mit Benutzerteil", login({ fields: { origins: ["https://u:p@portal.example.com"] } })],
        ["Ursprung mit Schema ftp", login({ fields: { origins: ["ftp://portal.example.com"] } })],
        ["Ursprung ohne Host", login({ fields: { origins: ["https://"] } })],
        ["kein Ursprung", login({ fields: { origins: [] } })],
        ["Großbuchstaben im Namen", login({ name: "Portal" })],
        ["Name beginnt mit Punkt", login({ name: ".portal" })],
        ["Name mit 65 Zeichen", login({ name: "a".repeat(65) })],
        ["Geheimfeld eines anderen Typs", login({ secrets: { password: "pw", token: "t" } })],
        ["Login ohne Passwort", login({ secrets: {} })],
        ["leeres Passwort", login({ secrets: { password: "" } })],
        ["SSH ohne Schlüssel und Passwort", { name: "nas", type: "ssh", fields: { username: "root" }, secrets: { passphrase: "p" } }],
        ["unbekannte Engine", { name: "db", type: "database", fields: { engine: "oracle", host: "db", database: "x" } }],
        ["Postgres ohne Host", { name: "db", type: "database", fields: { engine: "postgres", database: "x" } }],
        ["Header-Vorlage ohne {{secret}}", apiKey({ headerTemplate: "Bearer" })],
        ["Host mit Pfad", apiKey({ hosts: ["api.github.com/v3"] })],
        ["Angaben bei Sonstiges", { name: "misc", type: "generic", fields: { note: "x" }, secrets: { value: "x" } }],
        ["Bindung an eine Gruppe", login({ bindings: [{ kind: "group", targetId: 1 }] })],
        ["unbekannter Typ", login({ type: "note" })],
        ["unbekanntes Feld", login({ owner: 3 })],
    ];
    for (const [label, input] of rejected) {
        assert.ok(validate(createVaultItemValidation, input).error, label);
    }

    const update = updateVaultItemSchema("login");
    assert.strictEqual(validate(update, { secrets: { password: "neu" } }).error, undefined);
    assert.deepStrictEqual(validate(update, { fields: { origins: ["https://Login.Example.net:443"] } }).value.fields.origins, ["https://login.example.net"]);
    for (const [label, input] of [
        ["Typwechsel", { type: "api_key" }],
        ["Besitzerwechsel", { organizationId: 20 }],
        ["leere Änderung", {}],
        ["Ursprung mit Pfad", { fields: { origins: ["https://login.example.net/path"] } }],
        ["Geheimfeld eines anderen Typs", { secrets: { token: "t" } }],
    ]) {
        assert.ok(validate(update, input).error, label);
    }

    const settings = (agentUrl) => validate(updateVaultSettingsValidation, { agentUrl });
    assert.strictEqual(settings("https://outpost.example.com/").value.agentUrl, "https://outpost.example.com");
    assert.strictEqual(settings("http://10.0.0.2:6989/outpost/").value.agentUrl, "http://10.0.0.2:6989/outpost");
    assert.strictEqual(settings("").error, undefined);
    for (const agentUrl of ["ftp://outpost.example.com", "https://outpost.example.com/?x=1", "https://u:p@outpost.example.com", "outpost.example.com"]) {
        assert.ok(settings(agentUrl).error, agentUrl);
    }
});

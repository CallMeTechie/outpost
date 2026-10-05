process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const { Sequelize, DataTypes } = require("sequelize");

// The models bind to server/utils/database at require time, which would open data/outpost.db.
const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true } });
const databasePath = require.resolve("../../utils/database");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: db };

const OIDCProvider = require("../../models/OIDCProvider");
const Session = require("../../models/Session");
const { logout } = require("../../controllers/auth");
const { createOIDCSessionContext } = require("../../utils/oidcSession");
const migration = require("../../migrations/0045-add-oidc-logout");

test.before(async () => {
    await db.sync();
});

const oidcSession = async (endSessionEndpoint) => {
    const provider = await OIDCProvider.create({
        name: "Authentik", issuer: "https://idp.example.com/application/o/outpost/",
        clientId: "outpost-client", clientSecret: "secret",
        redirectUri: "https://outpost.example.com/api/auth/oidc/callback", endSessionEndpoint,
    });
    return Session.create({
        accountId: 1, ip: "OIDC Login", userAgent: "test",
        ...createOIDCSessionContext(provider.id, "the-id-token"),
    });
};

test("logging out of an OIDC session returns the IdP end-session URL and deletes the session", async () => {
    const session = await oidcSession("https://idp.example.com/end-session/?source=outpost");

    const result = await logout(session.token);

    const url = new URL(result.logoutUrl);
    assert.strictEqual(url.origin + url.pathname, "https://idp.example.com/end-session/");
    assert.strictEqual(url.searchParams.get("source"), "outpost");
    assert.strictEqual(url.searchParams.get("id_token_hint"), "the-id-token");
    assert.strictEqual(url.searchParams.get("client_id"), "outpost-client");
    assert.strictEqual(url.searchParams.get("post_logout_redirect_uri"),
        "https://outpost.example.com/api/auth/oidc/logout/callback");
    assert.strictEqual(await Session.findOne({ where: { token: session.token } }), null);
});

test("a non-HTTP end-session endpoint is never handed to the browser - logout stays local", async () => {
    const session = await oidcSession("javascript:alert(document.domain)//");

    const result = await logout(session.token);

    assert.strictEqual(result.logoutUrl, undefined);
    assert.strictEqual(await Session.findOne({ where: { token: session.token } }), null);
});

test("the migration adds the logout columns to a fresh database and can run twice", async () => {
    const fresh = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
    const queryInterface = fresh.getQueryInterface();
    await queryInterface.createTable("oidc_providers", { id: { type: DataTypes.INTEGER, primaryKey: true } });
    await queryInterface.createTable("sessions", { id: { type: DataTypes.INTEGER, primaryKey: true } });

    await migration.up(queryInterface, DataTypes);
    await migration.up(queryInterface, DataTypes);

    assert.ok((await queryInterface.describeTable("oidc_providers")).endSessionEndpoint);
    const sessionColumns = await queryInterface.describeTable("sessions");
    for (const column of ["oidcProviderId", "oidcIdTokenEncrypted", "oidcIdTokenIV", "oidcIdTokenAuthTag"]) {
        assert.ok(sessionColumns[column], column);
    }
    await fresh.close();
});

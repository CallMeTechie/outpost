const client = require("openid-client");
const MicrosoftApp = require("../models/MicrosoftApp");
const MicrosoftConnection = require("../models/MicrosoftConnection");
const logger = require("../utils/logger");
const { buildScopes, hasAllFilesAccess } = require("../lib/microsoft/scopes");
const { createState, consumeState } = require("../lib/microsoft/authState");
const { sealRefreshToken, sealClientSecret, openClientSecret, MASKED_SECRET } = require("../lib/microsoft/tokenCrypto");
const { getConfiguration, resetConfiguration } = require("../lib/microsoft/configuration");
const { forget, forgetAll } = require("../lib/microsoft/tokenStore");

const TENANT_CONSENT_CODES = ["AADSTS65001", "AADSTS90094"];

// Microsoft reports a tenant that requires an administrator's consent either as consent_required
// or as access_denied with the AADSTS code in the description. The two are told apart so the user
// is not left to guess whether they cancelled or hit a wall they cannot pass on their own.
const mapAuthorizeError = (query = {}) => {
    const error = query.error;
    const description = typeof query.error_description === "string" ? query.error_description : "";

    if (error === "consent_required") return "consent_required";

    if (error === "access_denied") {
        return TENANT_CONSENT_CODES.some(code => description.includes(code)) ? "consent_required" : "access_denied";
    }

    return "authorize_failed";
};

const serializeConnection = (connection) => ({
    id: connection.id,
    displayName: connection.displayName,
    microsoftEmail: connection.microsoftEmail,
    grantedScopes: connection.grantedScopes,
    hasAllFilesAccess: hasAllFilesAccess(connection.grantedScopes),
    status: connection.status,
    lastRefreshAt: connection.lastRefreshAt,
    createdAt: connection.createdAt,
});

const startConnect = async (accountId, { allFiles = false } = {}) => {
    const { configuration, redirectUri } = await getConfiguration();

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const nonce = client.randomNonce();
    const scope = buildScopes(allFiles);

    const state = createState({ accountId, codeVerifier, nonce, scope });

    const url = client.buildAuthorizationUrl(configuration, {
        redirect_uri: redirectUri,
        scope,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        // Without this Microsoft silently reuses the account already signed in to the browser, and
        // connecting a second account becomes impossible.
        prompt: "select_account",
    });

    return { url: url.href };
};

const upsertConnection = async ({ accountId, microsoftAccountId, microsoftEmail, refreshToken, grantedScopes }) => {
    const sealed = sealRefreshToken(refreshToken);
    const existing = await MicrosoftConnection.findOne({ where: { accountId, microsoftAccountId } });

    if (existing) {
        // displayName stays untouched: the user may have renamed this connection. status and
        // lastRefreshAt are reset so that reconnecting a previously dead connection revives it.
        await MicrosoftConnection.update({
            ...sealed, microsoftEmail, grantedScopes, status: "connected", lastRefreshAt: new Date(),
        }, { where: { id: existing.id } });

        forget(existing.id);
        return existing.id;
    }

    const created = await MicrosoftConnection.create({
        accountId, microsoftAccountId, microsoftEmail,
        displayName: microsoftEmail || "Microsoft",
        ...sealed, grantedScopes, status: "connected", lastRefreshAt: new Date(),
    });

    return created.id;
};

// The post-exchange half is injectable so the account binding below can be tested at the seam where
// it is actually spent, not only inside authState. The defaults are the production wiring, so
// nothing about the behaviour of a real callback changes.
const handleCallback = async (query = {}, {
    loadConfiguration = getConfiguration,
    exchange = client.authorizationCodeGrant,
    upsert = upsertConnection,
} = {}) => {
    if (query.error) return { status: "error", reason: mapAuthorizeError(query) };

    // The account this connection belongs to comes from the stored entry alone. The callback
    // carries no session, and taking it from the request would let anyone attach their Microsoft
    // account to a foreign Outpost user.
    const entry = consumeState(query.state);
    if (!entry) return { status: "error", reason: "state_invalid" };

    let configuration;
    let redirectUri;
    try {
        ({ configuration, redirectUri } = await loadConfiguration());
    } catch (error) {
        logger.warn("Microsoft callback arrived while the integration was unavailable", { error: error.message });
        return { status: "error", reason: "app_disabled" };
    }

    try {
        const currentUrl = new URL(`${redirectUri}?${new URLSearchParams(query).toString()}`);

        const tokens = await exchange(configuration, currentUrl, {
            expectedState: query.state,
            expectedNonce: entry.nonce,
            pkceCodeVerifier: entry.codeVerifier,
        });

        if (!tokens.refresh_token) {
            logger.error("Microsoft returned no refresh token — offline_access was not granted");
            return { status: "error", reason: "no_refresh_token" };
        }

        const claims = tokens.claims() || {};
        const microsoftAccountId = claims.oid || claims.sub;
        if (!microsoftAccountId) return { status: "error", reason: "exchange_failed" };

        await upsert({
            accountId: entry.accountId,
            microsoftAccountId: String(microsoftAccountId),
            microsoftEmail: claims.email || claims.preferred_username || null,
            refreshToken: tokens.refresh_token,
            // Stored as Microsoft sent it: what was granted, not what was asked for.
            grantedScopes: tokens.scope || entry.scope,
        });

        return { status: "connected" };
    } catch (error) {
        logger.error("Microsoft token exchange failed", { error: error.message });
        return { status: "error", reason: "exchange_failed" };
    }
};

const listConnections = async (accountId) => {
    const connections = await MicrosoftConnection.findAll({ where: { accountId }, order: [["createdAt", "DESC"]] });
    return connections.map(serializeConnection);
};

const renameConnection = async (accountId, id, displayName) => {
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name) return { code: 400, message: "A name is required" };

    const connection = await MicrosoftConnection.findOne({ where: { id, accountId } });
    if (!connection) return { code: 404, message: "Connection not found" };

    await MicrosoftConnection.update({ displayName: name.slice(0, 64) }, { where: { id: connection.id } });

    return serializeConnection({ ...connection, displayName: name.slice(0, 64) });
};

const deleteConnection = async (accountId, id) => {
    const connection = await MicrosoftConnection.findOne({ where: { id, accountId } });
    if (!connection) return { code: 404, message: "Connection not found" };

    await MicrosoftConnection.destroy({ where: { id: connection.id } });
    forget(connection.id);

    logger.system("Microsoft connection removed", { accountId, connectionId: connection.id });
    return { success: true };
};

const serializeApp = (app) => app && ({
    clientId: app.clientId,
    redirectUri: app.redirectUri,
    enabled: Boolean(app.enabled),
    clientSecret: app.clientSecret ? MASKED_SECRET : null,
});

const getApp = async () => serializeApp(await MicrosoftApp.findOne()) || null;

const saveApp = async ({ clientId, clientSecret, redirectUri, enabled }) => {
    const existing = await MicrosoftApp.findOne();

    // The API hands out a mask instead of the secret, so the form sends the mask back untouched.
    const secretChanged = typeof clientSecret === "string" && clientSecret !== MASKED_SECRET && clientSecret !== "";
    const sealed = secretChanged ? sealClientSecret(clientSecret) : {};

    if (existing) {
        if (!secretChanged && !openClientSecret(existing) && enabled) {
            return { code: 400, message: "A client secret is required before the integration can be enabled" };
        }

        await MicrosoftApp.update({ clientId, redirectUri, enabled, ...sealed }, { where: { id: existing.id } });
    } else {
        if (!secretChanged) return { code: 400, message: "A client secret is required" };

        await MicrosoftApp.create({ clientId, redirectUri, enabled, ...sealed });
    }

    // The configuration is cached in memory; without this the change would only take effect after
    // a restart. resetConfiguration alone does not reach running connections: the token store keeps
    // its own cache of access tokens and serves it before the configuration is ever consulted, so
    // disabling the integration has to drop those tokens as well.
    resetConfiguration();
    forgetAll();

    logger.system("Microsoft app registration saved", { clientId, enabled: Boolean(enabled) });
    return await getApp();
};

const deleteApp = async () => {
    await MicrosoftApp.destroy({ where: {} });

    // As in saveApp: the configuration cache and the access token cache are two different caches,
    // and only clearing both stops handing out Graph tokens for a registration that is now gone.
    resetConfiguration();
    forgetAll();

    logger.system("Microsoft app registration removed");
    return { success: true };
};

module.exports = {
    mapAuthorizeError,
    startConnect,
    handleCallback,
    listConnections,
    renameConnection,
    deleteConnection,
    getApp,
    saveApp,
    deleteApp,
};

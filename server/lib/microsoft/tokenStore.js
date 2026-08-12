const client = require("openid-client");
const MicrosoftConnection = require("../../models/MicrosoftConnection");
const logger = require("../../utils/logger");
const { openRefreshToken, sealRefreshToken } = require("./tokenCrypto");
const { classifyTokenError, MicrosoftDisconnectedError, MicrosoftTemporaryError } = require("./errors");
const { getConfiguration } = require("./configuration");

// A transfer that starts with a token expiring in seconds would fail halfway through.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const DEFAULT_LIFETIME_S = 3600;

const createTokenStore = ({
    loadConnection, persistRefresh, markDisconnected, getConfiguration: loadConfig,
    refreshTokenGrant, now = () => Date.now(), log = (level, message, meta) => logger[level](message, meta),
}) => {
    const cache = new Map();
    const inflight = new Map();

    const renew = async (connectionId) => {
        const connection = await loadConnection(connectionId);
        if (!connection) throw new MicrosoftDisconnectedError("This Microsoft connection no longer exists");
        if (connection.status !== "connected") throw new MicrosoftDisconnectedError("This Microsoft connection is disconnected");

        const refreshToken = openRefreshToken(connection);
        if (!refreshToken) throw new MicrosoftDisconnectedError("This Microsoft connection has no usable token");

        const { configuration } = await loadConfig();

        let tokens;
        try {
            tokens = await refreshTokenGrant(configuration, refreshToken);
        } catch (error) {
            const verdict = classifyTokenError(error);

            if (verdict.kind === "final") {
                cache.delete(connectionId);
                await markDisconnected(connectionId);
                throw new MicrosoftDisconnectedError("Microsoft rejected the stored refresh token");
            }

            if (verdict.reason === "invalid_client") {
                log("error", "Microsoft rejected the client secret of the app registration — check it in the admin settings", {
                    connectionId, status: verdict.status,
                });
            }

            throw new MicrosoftTemporaryError(`Microsoft is currently unreachable (${verdict.reason})`, {
                retryAfter: verdict.retryAfter,
            });
        }

        // Nothing asynchronous may come between receiving the rotated token and storing it:
        // Microsoft has already spent the old one, so a crash in this gap kills the connection for
        // good. Deriving the expiry and filling the cache happens after the write, not before.
        await persistRefresh(connectionId, tokens.refresh_token || refreshToken);

        const lifetime = Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : DEFAULT_LIFETIME_S;
        cache.set(connectionId, { accessToken: tokens.access_token, expiresAt: now() + lifetime * 1000 });

        return tokens.access_token;
    };

    const getAccessToken = async (connectionId) => {
        const cached = cache.get(connectionId);
        if (cached && cached.expiresAt - now() > REFRESH_BUFFER_MS) return cached.accessToken;

        const running = inflight.get(connectionId);
        if (running) return running;

        // Microsoft swaps the refresh token on every renewal. A second renewal running in parallel
        // would present a token that is already spent and come back as invalid_grant — which would
        // disconnect a perfectly healthy connection.
        const pending = renew(connectionId).finally(() => {
            if (inflight.get(connectionId) === pending) inflight.delete(connectionId);
        });

        inflight.set(connectionId, pending);
        return pending;
    };

    const forget = (connectionId) => { cache.delete(connectionId); };

    return { getAccessToken, forget };
};

const store = createTokenStore({
    loadConnection: (connectionId) => MicrosoftConnection.findOne({ where: { id: connectionId } }),
    persistRefresh: (connectionId, token) => MicrosoftConnection.update(
        { ...sealRefreshToken(token), lastRefreshAt: new Date() }, { where: { id: connectionId } }),
    markDisconnected: (connectionId) => MicrosoftConnection.update(
        { status: "disconnected", refreshToken: null, refreshTokenIV: null, refreshTokenAuthTag: null },
        { where: { id: connectionId } }),
    getConfiguration,
    refreshTokenGrant: (configuration, refreshToken) => client.refreshTokenGrant(configuration, refreshToken),
});

module.exports = {
    REFRESH_BUFFER_MS,
    createTokenStore,
    getAccessToken: store.getAccessToken,
    forget: store.forget,
};

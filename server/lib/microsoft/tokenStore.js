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

    const renew = async (connectionId, entry) => {
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
                // Same ownership test as the success path below. An abandoned renewal may still be
                // holding a refresh token that a newer renewal has already rotated away, so its
                // invalid_grant says nothing about the connection — acting on it would delete the
                // fresh token and disconnect a connection that has just been renewed successfully.
                // The caller of *this* call still gets the error: it asked for a token and got none.
                if (inflight.get(connectionId) === entry && !entry.abandoned) {
                    cache.delete(connectionId);
                    await markDisconnected(connectionId);
                }
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

        // The cache write is conditional, the persist above is not. A renewal that was forgotten
        // while it was in flight — the connection deleted, the account gone, a reconnect that
        // stored a fresh token — must not put its result back into the cache, or a deleted
        // connection hands out tokens again and a reconnect is overwritten by the stale renewal.
        const lifetime = Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : DEFAULT_LIFETIME_S;
        if (inflight.get(connectionId) === entry && !entry.abandoned) {
            cache.set(connectionId, { accessToken: tokens.access_token, expiresAt: now() + lifetime * 1000 });
        }

        return tokens.access_token;
    };

    const getAccessToken = async (connectionId) => {
        const cached = cache.get(connectionId);
        if (cached && cached.expiresAt - now() > REFRESH_BUFFER_MS) return cached.accessToken;

        const running = inflight.get(connectionId);
        if (running) return running.promise;

        // Microsoft swaps the refresh token on every renewal. A second renewal running in parallel
        // would present a token that is already spent and come back as invalid_grant — which would
        // disconnect a perfectly healthy connection.
        // The entry is handed to renew so it can recognise itself later; its promise is filled in
        // right after, which is soon enough because renew only reads it past its first await.
        const entry = { abandoned: false };
        entry.promise = renew(connectionId, entry).finally(() => {
            if (inflight.get(connectionId) === entry) inflight.delete(connectionId);
        });

        inflight.set(connectionId, entry);
        return entry.promise;
    };

    const forget = (connectionId) => {
        cache.delete(connectionId);

        // The in-flight entry deliberately stays in the map. It is the single-flight lock, and
        // removing it would let a second renewal start against the same, not-yet-rotated refresh
        // token — the double submit Microsoft answers with invalid_grant, which would disconnect a
        // healthy connection. Marking it makes the running renewal discard its own result instead.
        const running = inflight.get(connectionId);
        if (running) running.abandoned = true;
    };

    // The configuration cache and the token cache are separate. Clearing only the configuration
    // would let an administrator disable the integration and still have valid access tokens handed
    // out for the rest of their hour-long lifetime.
    // The union, not only the cached ones: a connection whose first renewal is still in flight has
    // nothing in the cache yet, and would otherwise survive the registration change for one renewal.
    const forgetAll = () => {
        for (const connectionId of new Set([...cache.keys(), ...inflight.keys()])) forget(connectionId);
    };

    return { getAccessToken, forget, forgetAll };
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
    forgetAll: store.forgetAll,
};

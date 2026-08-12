const client = require("openid-client");
const MicrosoftApp = require("../../models/MicrosoftApp");
const { openClientSecret } = require("./tokenCrypto");
const { MicrosoftTemporaryError } = require("./errors");

// Both personal and work accounts sign in against `common`. Discovery returns
// https://login.microsoftonline.com/{tenantid}/v2.0 as the issuer; openid-client detects that
// placeholder and resolves the expected issuer per tenant from the id token's `tid` claim. A
// hand-built Configuration would not, and every work account would fail its id token check.
const MICROSOFT_ISSUER = "https://login.microsoftonline.com/common/v2.0";

const createConfigurationProvider = ({ loadActiveApp, discover }) => {
    let cached = null;

    const build = async () => {
        const app = await loadActiveApp();
        if (!app) throw new MicrosoftTemporaryError("The Microsoft integration is disabled");

        const clientSecret = openClientSecret(app);
        if (!clientSecret) throw new MicrosoftTemporaryError("The Microsoft integration is not configured");

        const configuration = await discover(new URL(MICROSOFT_ISSUER), app.clientId, clientSecret);

        return { configuration, clientId: app.clientId, redirectUri: app.redirectUri };
    };

    const getConfiguration = () => {
        if (cached) return cached;

        // Only ever this call's own promise, compared by identity: a reset plus a successful
        // rebuild can land between here and the rejection, and a blind `cached = null` would throw
        // away the newer, working configuration.
        const pending = build().catch((error) => {
            if (cached === pending) cached = null;
            throw error;
        });

        cached = pending;
        return pending;
    };

    const resetConfiguration = () => { cached = null; };

    return { getConfiguration, resetConfiguration };
};

const provider = createConfigurationProvider({
    loadActiveApp: () => MicrosoftApp.findOne({ where: { enabled: true } }),
    discover: (issuer, clientId, clientSecret) => client.discovery(issuer, clientId, clientSecret),
});

module.exports = {
    MICROSOFT_ISSUER,
    createConfigurationProvider,
    getConfiguration: provider.getConfiguration,
    resetConfiguration: provider.resetConfiguration,
};

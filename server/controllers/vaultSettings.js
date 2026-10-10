const VaultSettings = require("../models/VaultSettings");
const { getKeyStatus, isVaultEnabled } = require("../lib/vault/state");
const { activeOrganizationIds, canUseVault, canCreateFor } = require("../lib/vault/visibility");

const getAgentUrl = async () => (await VaultSettings.getOrCreate()).agentUrl || null;

const getVaultSettings = async () => ({ keyStatus: getKeyStatus(), agentUrl: await getAgentUrl() });

const updateVaultSettings = async ({ agentUrl }) => {
    const settings = await VaultSettings.getOrCreate();
    await settings.update({ agentUrl: agentUrl || null });
    return getVaultSettings();
};

const getVaultAvailability = async (accountId, { impersonating, trustProxyUnsafe }) => {
    const enabled = isVaultEnabled();
    const result = {
        enabled, canUse: false, canManageOrgs: [], canProvision: false,
        agentUrlSet: Boolean(await getAgentUrl()), impersonating, trustProxyUnsafe,
    };
    if (!enabled) return result;
    const canUse = await canUseVault(accountId);
    for (const organizationId of await activeOrganizationIds(accountId)) {
        if (await canCreateFor(accountId, { organizationId })) result.canManageOrgs.push(organizationId);
    }
    return { ...result, canUse, canProvision: canUse };
};

module.exports = { getAgentUrl, getVaultSettings, updateVaultSettings, getVaultAvailability };

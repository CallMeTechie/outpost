const VaultSettings = require("../models/VaultSettings");
const { getKeyStatus, isVaultEnabled } = require("../lib/vault/state");
const { activeOrganizationIds, canUseVault, canCreateFor } = require("../lib/vault/visibility");

const getVaultSettings = async () => {
    const settings = await VaultSettings.getOrCreate();
    return { keyStatus: getKeyStatus(), agentUrl: settings.agentUrl || null, ipBindingDefault: settings.ipBindingDefault !== false };
};

const updateVaultSettings = async ({ agentUrl, ipBindingDefault }) => {
    const settings = await VaultSettings.getOrCreate();
    await settings.update({
        ...(agentUrl !== undefined ? { agentUrl: agentUrl || null } : {}),
        ...(ipBindingDefault !== undefined ? { ipBindingDefault } : {}),
    });
    return getVaultSettings();
};

const getVaultAvailability = async (accountId, { impersonating, trustProxyUnsafe }) => {
    const enabled = isVaultEnabled();
    const { agentUrl, ipBindingDefault } = await getVaultSettings();
    const result = {
        enabled, canUse: false, canManageOrgs: [], canProvision: false,
        agentUrlSet: Boolean(agentUrl), impersonating, trustProxyUnsafe,
    };
    if (!enabled) return result;
    const canUse = await canUseVault(accountId);
    // The address is often a LAN address: only accounts that may set up agents get it.
    if (canUse) Object.assign(result, { agentUrl, ipBindingDefault });
    for (const organizationId of await activeOrganizationIds(accountId)) {
        if (await canCreateFor(accountId, { organizationId })) result.canManageOrgs.push(organizationId);
    }
    return { ...result, canUse, canProvision: canUse };
};

module.exports = { getVaultSettings, updateVaultSettings, getVaultAvailability };

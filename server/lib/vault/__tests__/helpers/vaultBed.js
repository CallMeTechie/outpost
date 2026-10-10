const { Sequelize } = require("sequelize");
const { VaultError, VaultErrorCode } = require("../../errors");
const { Permission } = require("../../../../permissions/registry");

const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const state = {
    enabled: true, items: [], secrets: new Map(), permissions: new Set(), memberships: 0,
    orgs: [], entries: new Map(), apiKeys: new Set(), updates: [], secretReads: 0,
};

const itemRef = (item) => (item.organizationId ? `org:${item.organizationId}/${item.name}` : item.name);

// Installed on require, before the provider is loaded: it destructures these modules.
fake("../../../../utils/database", new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false }));
fake("../../state", { isVaultEnabled: () => state.enabled });
fake("../../visibility", {
    itemRef,
    visibleItems: async () => state.items.map((item) => ({ ...item })),
    findVisibleItem: async (caller, ref) => {
        const item = state.items.find((candidate) => itemRef(candidate) === ref);
        if (!item) throw new VaultError(VaultErrorCode.ITEM_UNKNOWN, `No vault entry ${ref} is available to this connection.`);
        return { ...item };
    },
    canUseVault: async () => state.permissions.has(Permission.VAULT_USE) || state.memberships > 0,
});
fake("../../secrets", {
    readSecret: async (itemId, field) => {
        state.secretReads += 1;
        return state.secrets.get(`${itemId}:${field}`) ?? null;
    },
});
fake("../../../../utils/permission", { hasAccountPermission: async (accountId, permission) => state.permissions.has(permission) });
fake("../../../../models/VaultItem", {
    update: async (values, options) => {
        state.updates.push({ values, where: options.where, silent: options.silent });
        return [1];
    },
});
fake("../../../../models/ApiKey", { count: async ({ where }) => (where.pending === false && state.apiKeys.has(where.id) ? 1 : 0) });
fake("../../../../models/Organization", { findAll: async () => state.orgs });
fake("../../../../models/Entry", { findByPk: async (id) => state.entries.get(id) ?? null });

const reset = ({ items = [], secrets = {}, permissions = [], memberships = 0, orgs = [], entries = [], apiKeys = [] } = {}) => {
    Object.assign(state, {
        enabled: true, items, secrets: new Map(Object.entries(secrets)), permissions: new Set(permissions), memberships,
        orgs, entries: new Map(entries.map((entry) => [entry.id, entry])), apiKeys: new Set(apiKeys), updates: [], secretReads: 0,
    });
};

module.exports = { state, reset };

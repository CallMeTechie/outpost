const { Op } = require("sequelize");
const VaultItem = require("../../models/VaultItem");
const VaultBinding = require("../../models/VaultBinding");
const Entry = require("../../models/Entry");
const Folder = require("../../models/Folder");
const EntryTag = require("../../models/EntryTag");
const OrganizationMember = require("../../models/OrganizationMember");
const { hasAccountPermission, hasOrganizationAccess, hasOrganizationPermission } = require("../../utils/permission");
const { Permission } = require("../../permissions/registry");
const { resolveEntryScope, validateEntryAccess } = require("../../controllers/entry");
const { VaultError, VaultErrorCode } = require("./errors");

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF_PATTERN = /^(?:org:([1-9][0-9]{0,9})\/)?([^/]+)$/;

const unknownItem = () => new VaultError(VaultErrorCode.ITEM_UNKNOWN);

const itemRef = (item) => (item.organizationId ? `org:${item.organizationId}/${item.name}` : item.name);

const parseItemRef = (ref) => {
    const match = typeof ref === "string" ? REF_PATTERN.exec(ref) : null;
    if (!match || !NAME_PATTERN.test(match[2])) throw unknownItem();
    return { organizationId: match[1] ? Number(match[1]) : null, name: match[2] };
};

const activeOrganizationIds = async (accountId) =>
    (await OrganizationMember.findAll({ where: { accountId, status: "active" } })).map((membership) => membership.organizationId);

const canUseVault = async (accountId) =>
    (await hasAccountPermission(accountId, Permission.VAULT_USE)) || (await activeOrganizationIds(accountId)).length > 0;

const ownedItems = async (accountId) => {
    const owners = [];
    if (await hasAccountPermission(accountId, Permission.VAULT_USE)) owners.push({ accountId, organizationId: null });
    const organizationIds = await activeOrganizationIds(accountId);
    if (organizationIds.length) owners.push({ organizationId: { [Op.in]: organizationIds } });
    if (!owners.length) return [];
    return VaultItem.findAll({ where: { [Op.or]: owners }, order: [["name", "ASC"]] });
};

const folderLineage = async (folderId) => {
    const ids = [];
    let current = folderId;
    while (current && !ids.includes(current)) {
        const folder = await Folder.findByPk(current);
        if (!folder) break;
        ids.push(folder.id);
        current = folder.parentId;
    }
    return ids;
};

const serverContext = async (accountId, entryId) => {
    const entry = await Entry.findByPk(entryId);
    if (!entry || !(await validateEntryAccess(accountId, entry)).valid) return null;
    const { organizationId } = await resolveEntryScope(entry);
    const tagIds = (await EntryTag.findAll({ where: { entryId: entry.id } })).map((row) => row.tagId);
    return { entryId: entry.id, organizationId: organizationId ?? null, folderIds: await folderLineage(entry.folderId), tagIds };
};

const bindingMatches = (binding, server, item) => {
    if (binding.kind === "entry") return binding.targetId === server.entryId;
    if (binding.kind === "folder") return server.folderIds.includes(binding.targetId);
    return binding.kind === "tag" && !item.organizationId && server.tagIds.includes(binding.targetId);
};

const visibleItems = async ({ accountId, agent = null }) => {
    if (!agent?.entryId)
        return (await ownedItems(accountId)).filter((item) => !item.organizationId && item.allServers);

    const server = await serverContext(accountId, agent.entryId);
    if (!server) return [];

    const items = (await ownedItems(accountId))
        .filter((item) => !item.organizationId || item.organizationId === server.organizationId);
    if (!items.length) return [];

    const bindings = await VaultBinding.findAll({ where: { itemId: { [Op.in]: items.map((item) => item.id) } } });
    return items.filter((item) => item.allServers
        || bindings.some((binding) => binding.itemId === item.id && bindingMatches(binding, server, item)));
};

const findVisibleItem = async (caller, ref) => {
    const { organizationId, name } = parseItemRef(ref);
    const item = (await visibleItems(caller))
        .find((candidate) => candidate.name === name && (candidate.organizationId ?? null) === organizationId);
    if (!item) throw unknownItem();
    return item;
};

const memberWith = async (accountId, organizationId, permission) =>
    (await hasOrganizationAccess(accountId, organizationId)) && hasOrganizationPermission(accountId, organizationId, permission);

const canManageItem = async (accountId, item) => {
    if (item.organizationId) return memberWith(accountId, item.organizationId, Permission.VAULT_MANAGE);
    return item.accountId === accountId && hasAccountPermission(accountId, Permission.VAULT_USE);
};

const canRevealItem = async (accountId, item) => {
    if (item.organizationId) return memberWith(accountId, item.organizationId, Permission.VAULT_REVEAL);
    return canManageItem(accountId, item);
};

const canCreateFor = async (accountId, { organizationId = null } = {}) => {
    if (organizationId) return memberWith(accountId, organizationId, Permission.VAULT_MANAGE);
    return hasAccountPermission(accountId, Permission.VAULT_USE);
};

module.exports = {
    itemRef,
    parseItemRef,
    activeOrganizationIds,
    ownedItems,
    canUseVault,
    visibleItems,
    findVisibleItem,
    canManageItem,
    canRevealItem,
    canCreateFor,
};

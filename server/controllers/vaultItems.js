const { Op } = require("sequelize");
const VaultItem = require("../models/VaultItem");
const VaultSecret = require("../models/VaultSecret");
const VaultBinding = require("../models/VaultBinding");
const Organization = require("../models/Organization");
const Entry = require("../models/Entry");
const Folder = require("../models/Folder");
const Tag = require("../models/Tag");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("./audit");
const {
    itemRef, activeOrganizationIds, ownedItems, canManageItem, canRevealItem, canCreateFor,
} = require("../lib/vault/visibility");
const { validateBindings, setBindings } = require("../lib/vault/bindings");
const { readSecret, writeSecret, clearSecrets, isUnreadable } = require("../lib/vault/secrets");
const { VaultError, VaultErrorCode } = require("../lib/vault/errors");
const { SECRET_FIELDS, updateVaultItemSchema } = require("../validations/vault");
const logger = require("../utils/logger");

const NOT_FOUND = { code: 404, message: "Vault entry not found" };
const FORBIDDEN = { code: 403, message: "You are not allowed to do this with this vault entry" };
const NAME_TAKEN = { code: 409, message: "A vault entry with this name already exists for this owner" };
const APPROVAL_OFF_FORBIDDEN = { code: 403, message: "Turning off approvals requires a signed-in session" };
const TARGET_FIELD = { login: "origins", api_key: "hosts", database: "host" };
const LABEL_MODELS = { entry: Entry, folder: Folder, tag: Tag };
const ITEM_COLUMNS = ["name", "description", "fields", "approvalRequired", "allServers"];

const targetOf = (type, fields) => JSON.stringify([].concat(fields?.[TARGET_FIELD[type]] ?? []).sort());

// SEC-TENANT-01: every lookup by id is scoped to the caller's own entries and active memberships.
const findScopedItem = async (accountId, id) => {
    if (!Number.isInteger(id)) return null;
    return VaultItem.findOne({
        where: { id, [Op.or]: [{ accountId }, { organizationId: { [Op.in]: await activeOrganizationIds(accountId) } }] },
    });
};

const nameTaken = async ({ accountId, organizationId }, name, exceptId = null) => Boolean(await VaultItem.findOne({
    where: {
        name, ...(organizationId ? { organizationId } : { accountId }),
        ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}),
    },
    attributes: ["id"],
}));

const bindingLabels = async (bindings) => {
    const labels = {};
    for (const [kind, Model] of Object.entries(LABEL_MODELS)) {
        const ids = bindings.filter((binding) => binding.kind === kind).map((binding) => binding.targetId);
        if (!ids.length) continue;
        for (const row of await Model.findAll({ where: { id: ids }, attributes: ["id", "name"] })) labels[`${kind}:${row.id}`] = row.name;
    }
    return labels;
};

const serializeItems = async (caller, items) => {
    if (!items.length) return [];
    const ids = items.map((item) => item.id);
    const organizationIds = [...new Set(items.map((item) => item.organizationId).filter(Boolean))];
    const [secrets, bindings, organizations] = await Promise.all([
        VaultSecret.findAll({ where: { itemId: ids }, attributes: ["itemId", "field"] }),
        VaultBinding.findAll({ where: { itemId: ids }, attributes: ["itemId", "kind", "targetId"] }),
        organizationIds.length ? Organization.findAll({ where: { id: organizationIds }, attributes: ["id", "name"] }) : [],
    ]);
    const labels = await bindingLabels(bindings);
    return Promise.all(items.map(async (item) => ({
        id: item.id,
        ref: itemRef(item),
        accountId: item.accountId ?? null,
        organizationId: item.organizationId ?? null,
        ownerName: organizations.find((organization) => organization.id === item.organizationId)?.name ?? null,
        name: item.name,
        type: item.type,
        description: item.description ?? null,
        fields: item.fields ?? {},
        approvalRequired: item.approvalRequired,
        allServers: item.allServers,
        bindings: bindings.filter((binding) => binding.itemId === item.id)
            .map(({ kind, targetId }) => ({ kind, targetId, label: labels[`${kind}:${targetId}`] ?? null })),
        secretFields: secrets.filter((secret) => secret.itemId === item.id).map((secret) => secret.field).sort(),
        unreadable: isUnreadable(item.id),
        lastUsedAt: item.lastUsedAt ?? null,
        canManage: await canManageItem(caller.accountId, item),
        canReveal: caller.revealAllowed && await canRevealItem(caller.accountId, item),
    })));
};

const serializeOne = async (caller, id) => (await serializeItems(caller, [await VaultItem.findByPk(id)]))[0];

const audit = (caller, item, action, details = {}) => createAuditLog({
    accountId: caller.accountId,
    organizationId: item.organizationId ?? null,
    action,
    resource: RESOURCE_TYPES.VAULT,
    resourceId: item.id,
    details: {
        item: itemRef(item), type: item.type, ...details,
        ...(caller.impersonatorId ? { impersonatorId: caller.impersonatorId } : {}),
    },
    ipAddress: caller.ipAddress ?? null,
    userAgent: caller.userAgent ?? null,
});

const removeItem = async (id) => {
    await clearSecrets(id);
    await setBindings(id, []);
    await VaultItem.destroy({ where: { id } });
};

module.exports.listItems = async (caller) => ({ items: await serializeItems(caller, await ownedItems(caller.accountId)) });

module.exports.createItem = async (caller, body) => {
    const { organizationId, name, type, description, fields, secrets, approvalRequired, allServers, bindings } = body;
    if (!(await canCreateFor(caller.accountId, { organizationId }))) return FORBIDDEN;
    if (approvalRequired === false && !caller.revealAllowed) return APPROVAL_OFF_FORBIDDEN;
    const check = await validateBindings({ accountId: caller.accountId, organizationId }, bindings);
    if (!check.valid) return { code: 400, message: check.message };
    const owner = organizationId ? { accountId: null, organizationId } : { accountId: caller.accountId, organizationId: null };
    if (await nameTaken(owner, name)) return NAME_TAKEN;

    let item;
    try {
        item = await VaultItem.create({
            ...owner, name, type, description: description || null, fields, approvalRequired, allServers, createdBy: caller.accountId,
        });
    } catch (error) {
        if (error.name === "SequelizeUniqueConstraintError") return NAME_TAKEN;
        throw error;
    }
    try {
        for (const [field, value] of Object.entries(secrets)) await writeSecret(item.id, field, value);
        await setBindings(item.id, bindings);
    } catch (error) {
        await removeItem(item.id).catch((cleanupError) =>
            logger.error("Could not remove a half-created vault entry", { itemId: item.id, error: cleanupError.message }));
        throw error;
    }
    await audit(caller, item, AUDIT_ACTIONS.VAULT_ITEM_CREATE, { name, secretFields: Object.keys(secrets) });
    return { item: await serializeOne(caller, item.id) };
};

module.exports.updateItem = async (caller, id, body) => {
    const item = await findScopedItem(caller.accountId, id);
    if (!item) return NOT_FOUND;
    if (!(await canManageItem(caller.accountId, item))) return FORBIDDEN;
    const { error, value } = updateVaultItemSchema(item.type).validate(body, { errors: { wrap: { label: "" } }, allowUnknown: false });
    if (error) return { code: 400, message: error.details[0].message };
    if (value.approvalRequired === false && item.approvalRequired !== false && !caller.revealAllowed) return APPROVAL_OFF_FORBIDDEN;
    if (value.name !== undefined && value.name !== item.name && await nameTaken(item, value.name, item.id)) return NAME_TAKEN;
    if (value.bindings) {
        const check = await validateBindings({ accountId: caller.accountId, organizationId: item.organizationId ?? null }, value.bindings);
        if (!check.valid) return { code: 400, message: check.message };
    }

    // A new target with the old value would let vault.manage without vault.reveal send an
    // organization's password to a page of their choosing.
    const secretsCleared = value.fields !== undefined && targetOf(item.type, value.fields) !== targetOf(item.type, item.fields);
    if (secretsCleared) await clearSecrets(item.id);
    const changes = Object.fromEntries(ITEM_COLUMNS.filter((column) => value[column] !== undefined).map((column) => [column, value[column]]));
    if (changes.description === "") changes.description = null;
    if (Object.keys(changes).length) {
        try {
            await VaultItem.update(changes, { where: { id: item.id } });
        } catch (error) {
            if (error.name === "SequelizeUniqueConstraintError") return NAME_TAKEN;
            throw error;
        }
    }
    for (const [field, secret] of Object.entries(value.secrets ?? {})) await writeSecret(item.id, field, secret);
    // "For this session" grants are stamped with updatedAt (approvals.js), so a new value has to move it.
    // Model.update skips a change that touches only updatedAt.
    if (Object.keys(value.secrets ?? {}).length)
        await VaultItem.sequelize.getQueryInterface().bulkUpdate(VaultItem.getTableName(), { updatedAt: new Date() }, { id: item.id }, {}, VaultItem.getAttributes());
    if (value.bindings) await setBindings(item.id, value.bindings);

    await audit(caller, item, AUDIT_ACTIONS.VAULT_ITEM_UPDATE, {
        name: value.name ?? item.name,
        changed: [...Object.keys(changes), ...(value.bindings ? ["bindings"] : [])],
        secretFields: Object.keys(value.secrets ?? {}),
        secretsCleared,
    });
    return { item: await serializeOne(caller, item.id), secretsCleared };
};

module.exports.deleteItem = async (caller, id) => {
    const item = await findScopedItem(caller.accountId, id);
    if (!item) return NOT_FOUND;
    if (!(await canManageItem(caller.accountId, item))) return FORBIDDEN;
    await removeItem(item.id);
    await audit(caller, item, AUDIT_ACTIONS.VAULT_ITEM_DELETE, { name: item.name });
    return { success: true };
};

module.exports.revealSecret = async (caller, id, field) => {
    const item = await findScopedItem(caller.accountId, id);
    if (!item || !SECRET_FIELDS[item.type]?.includes(field)) return NOT_FOUND;
    if (!(await canRevealItem(caller.accountId, item))) return FORBIDDEN;
    let value;
    try {
        value = await readSecret(item.id, field);
    } catch (error) {
        if (!(error instanceof VaultError) || error.code !== VaultErrorCode.ITEM_UNREADABLE) throw error;
        logger.warn("Vault entry cannot be decrypted", { itemId: item.id });
        await audit(caller, item, AUDIT_ACTIONS.VAULT_ITEM_UNREADABLE, { field });
        return { code: 422, message: "This vault entry cannot be read with the current vault key" };
    }
    if (value === null) return NOT_FOUND;
    await audit(caller, item, AUDIT_ACTIONS.VAULT_REVEAL, { field });
    return { value };
};

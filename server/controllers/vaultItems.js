const { Op } = require("sequelize");
const VaultItem = require("../models/VaultItem");
const VaultSecret = require("../models/VaultSecret");
const VaultBinding = require("../models/VaultBinding");
const Organization = require("../models/Organization");
const Entry = require("../models/Entry");
const Folder = require("../models/Folder");
const Tag = require("../models/Tag");
const Account = require("../models/Account");
const VaultSshHostKey = require("../models/VaultSshHostKey");
const { hasAccountPermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("./audit");
const {
    itemRef, activeOrganizationIds, ownedItems, canManageItem, canRevealItem, canCreateFor,
} = require("../lib/vault/visibility");
const { validateBindings, setBindings } = require("../lib/vault/bindings");
const { targetRefsOf, parseTargetRef, usableSshServer, pinnedKey, forgetKey, dropKeysExcept } = require("../lib/vault/sshTargets");
const { readSecret, writeSecret, clearSecrets, isUnreadable } = require("../lib/vault/secrets");
const { VaultError, VaultErrorCode } = require("../lib/vault/errors");
const { SECRET_FIELDS, updateVaultItemSchema } = require("../validations/vault");
const db = require("../utils/database");
const logger = require("../utils/logger");

const NOT_FOUND = { code: 404, message: "Vault entry not found" };
const FORBIDDEN = { code: 403, message: "You are not allowed to do this with this vault entry" };
const NAME_TAKEN = { code: 409, message: "A vault entry with this name already exists for this owner" };
const APPROVAL_OFF_FORBIDDEN = { code: 403, message: "Turning off approvals requires a signed-in session" };
const SESSION_ON_FORBIDDEN = { code: 403, message: "Allowing approvals for a whole session requires a signed-in session" };
const HOST_KEY_NOT_FOUND = { code: 404, message: "No host key is stored for this target" };
const FREE_HOSTS_FORBIDDEN = { code: 400, message: "Free hosts need the permission to connect without an entry" };
const TARGET_FIELDS = {
    login: ["origins"], api_key: ["hosts", "fillOrigins"], ssh: ["servers", "hosts"], database: ["host"], generic: ["fillOrigins"],
};
const LABEL_MODELS = { entry: Entry, folder: Folder, tag: Tag };
const ITEM_COLUMNS = ["name", "description", "fields", "approvalRequired", "allServers"];

const targetOf = (type, fields) => JSON.stringify((TARGET_FIELDS[type] ?? []).map((field) => [].concat(fields?.[field] ?? []).sort()));

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

const hostKeysOf = async (items) => {
    const byItem = new Map();
    const ids = items.filter((item) => item.type === "ssh").map((item) => item.id);
    if (!ids.length) return byItem;
    const rows = await VaultSshHostKey.findAll({ where: { itemId: ids }, order: [["target", "ASC"]] });
    const accountIds = [...new Set(rows.map((row) => row.confirmedBy).filter(Boolean))];
    const accounts = accountIds.length ? await Account.findAll({ where: { id: accountIds }, attributes: ["id", "firstName", "lastName"] }) : [];
    for (const row of rows) {
        const account = accounts.find((candidate) => candidate.id === row.confirmedBy);
        byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), {
            target: row.target, algorithm: row.algorithm, fingerprint: row.fingerprint, confirmedAt: row.confirmedAt,
            confirmedBy: account ? { id: account.id, name: `${account.firstName} ${account.lastName}` } : null,
        }]);
    }
    return byItem;
};

// Only targets this save adds: kept ones were checked when they were added, and every tool call checks the agent's account again.
const sshTargetProblem = async (accountId, organizationId, fields, previous = {}) => {
    for (const id of fields.servers ?? []) {
        if ((previous.servers ?? []).includes(id)) continue;
        if (!(await usableSshServer(accountId, organizationId, id)))
            return { code: 400, message: `Server ${id} is not an SSH server you can use for this entry` };
    }
    const addsHost = (fields.hosts ?? []).some((host) => !(previous.hosts ?? []).includes(host));
    if (addsHost && !(await hasAccountPermission(accountId, Permission.CONNECT_DIRECT))) return FREE_HOSTS_FORBIDDEN;
    return null;
};

const serializeItems = async (caller, items) => {
    if (!items.length) return [];
    const ids = items.map((item) => item.id);
    const organizationIds = [...new Set(items.map((item) => item.organizationId).filter(Boolean))];
    const [secrets, bindings, organizations, hostKeys] = await Promise.all([
        VaultSecret.findAll({ where: { itemId: ids }, attributes: ["itemId", "field"] }),
        VaultBinding.findAll({ where: { itemId: ids }, attributes: ["itemId", "kind", "targetId"] }),
        organizationIds.length ? Organization.findAll({ where: { id: organizationIds }, attributes: ["id", "name"] }) : [],
        hostKeysOf(items),
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
        ...(item.type === "ssh" ? { hostKeys: hostKeys.get(item.id) ?? [] } : {}),
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
    await dropKeysExcept(id, []);
    await VaultItem.destroy({ where: { id } });
};

module.exports.listItems = async (caller) => ({ items: await serializeItems(caller, await ownedItems(caller.accountId)) });

module.exports.getItem = async (caller, id) => {
    const item = (await ownedItems(caller.accountId)).find((candidate) => candidate.id === id);
    return item ? { item: (await serializeItems(caller, [item]))[0] } : NOT_FOUND;
};

module.exports.createItem = async (caller, body) => {
    const { organizationId, name, type, description, fields, secrets, approvalRequired, allServers, bindings } = body;
    if (!(await canCreateFor(caller.accountId, { organizationId }))) return FORBIDDEN;
    if (approvalRequired === false && !caller.revealAllowed) return APPROVAL_OFF_FORBIDDEN;
    if (type === "ssh" && fields?.allowSession === true && !caller.revealAllowed) return SESSION_ON_FORBIDDEN;
    const check = await validateBindings({ accountId: caller.accountId, organizationId }, bindings);
    if (!check.valid) return { code: 400, message: check.message };
    if (type === "ssh") {
        const problem = await sshTargetProblem(caller.accountId, organizationId, fields);
        if (problem) return problem;
    }
    const owner = organizationId ? { accountId: null, organizationId } : { accountId: caller.accountId, organizationId: null };
    if (await nameTaken(owner, name)) return NAME_TAKEN;

    let item;
    try {
        item = await db.transaction(async (transaction) => {
            const created = await VaultItem.create({
                ...owner, name, type, description: description || null, fields, approvalRequired, allServers, createdBy: caller.accountId,
            }, { transaction });
            for (const [field, value] of Object.entries(secrets)) await writeSecret(created.id, field, value, { transaction });
            await setBindings(created.id, bindings, { transaction });
            return created;
        });
    } catch (error) {
        if (error.name === "SequelizeUniqueConstraintError") return NAME_TAKEN;
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
    if (item.type === "ssh" && value.fields?.allowSession === true && item.fields?.allowSession !== true && !caller.revealAllowed)
        return SESSION_ON_FORBIDDEN;
    if (value.name !== undefined && value.name !== item.name && await nameTaken(item, value.name, item.id)) return NAME_TAKEN;
    if (value.bindings) {
        const check = await validateBindings({ accountId: caller.accountId, organizationId: item.organizationId ?? null }, value.bindings);
        if (!check.valid) return { code: 400, message: check.message };
    }
    if (item.type === "ssh" && value.fields) {
        const problem = await sshTargetProblem(caller.accountId, item.organizationId ?? null, value.fields, item.fields ?? {});
        if (problem) return problem;
    }

    // A new target with the old value would let vault.manage without vault.reveal send an
    // organization's password to a page of their choosing.
    const secretsCleared = value.fields !== undefined && targetOf(item.type, value.fields) !== targetOf(item.type, item.fields);
    const changes = Object.fromEntries(ITEM_COLUMNS.filter((column) => value[column] !== undefined).map((column) => [column, value[column]]));
    if (changes.description === "") changes.description = null;
    try {
        await db.transaction(async (transaction) => {
            if (Object.keys(changes).length) await VaultItem.update(changes, { where: { id: item.id }, transaction });
            if (secretsCleared) await clearSecrets(item.id, { transaction });
            if (item.type === "ssh" && value.fields) await dropKeysExcept(item.id, targetRefsOf({ fields: value.fields }), { transaction });
            for (const [field, secret] of Object.entries(value.secrets ?? {})) await writeSecret(item.id, field, secret, { transaction });
            // "For this session" grants are stamped with updatedAt (approvals.js), so a new value has to move it.
            // Model.update skips a change that touches only updatedAt.
            if (Object.keys(value.secrets ?? {}).length)
                await VaultItem.sequelize.getQueryInterface().bulkUpdate(VaultItem.getTableName(), { updatedAt: new Date() }, { id: item.id }, { transaction }, VaultItem.getAttributes());
            if (value.bindings) await setBindings(item.id, value.bindings, { transaction });
        });
    } catch (error) {
        if (error.name === "SequelizeUniqueConstraintError") return NAME_TAKEN;
        throw error;
    }

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

module.exports.forgetHostKey = async (caller, id, target) => {
    const item = await findScopedItem(caller.accountId, id);
    if (!item || item.type !== "ssh") return NOT_FOUND;
    if (!(await canManageItem(caller.accountId, item))) return FORBIDDEN;
    const pinned = parseTargetRef(target) ? await pinnedKey(item.id, target) : null;
    if (!pinned || !(await forgetKey(item.id, target))) return HOST_KEY_NOT_FOUND;
    await VaultItem.sequelize.getQueryInterface().bulkUpdate(VaultItem.getTableName(), { updatedAt: new Date() }, { id: item.id }, {}, VaultItem.getAttributes());
    await audit(caller, item, AUDIT_ACTIONS.VAULT_SSH_HOST_KEY_FORGOTTEN, { target, fingerprint: pinned.fingerprint });
    return { success: true };
};

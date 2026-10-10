const { Op } = require("sequelize");
const db = require("../../utils/database");
const VaultBinding = require("../../models/VaultBinding");
const Entry = require("../../models/Entry");
const Tag = require("../../models/Tag");
const { validateFolderAccess } = require("../../utils/permission");

const removeBindings = async (kind, ids) => {
    const targetIds = (ids ?? []).filter((id) => id !== null && id !== undefined);
    if (!targetIds.length) return 0;
    return VaultBinding.destroy({ where: { kind, targetId: { [Op.in]: targetIds } } });
};

const bindingProblem = async ({ accountId, organizationId }, { kind, targetId }) => {
    // controllers/entry requires this module, so it is only complete once both have loaded.
    const { validateEntryAccess, resolveEntryScope } = require("../../controllers/entry");

    if (kind === "tag") {
        if (organizationId) return "Organization items cannot apply to tags";
        const tag = await Tag.findByPk(targetId);
        return tag && tag.accountId === accountId ? null : "Tag not found";
    }
    if (kind === "entry") {
        const entry = await Entry.findByPk(targetId);
        if (!entry || !(await validateEntryAccess(accountId, entry)).valid) return "Server not found";
        if (organizationId && (await resolveEntryScope(entry)).organizationId !== organizationId)
            return "Organization items can only apply to servers of the same organization";
        return null;
    }
    if (kind === "folder") {
        const access = await validateFolderAccess(accountId, targetId);
        if (!access.valid) return "Folder not found";
        if (organizationId && access.folder.organizationId !== organizationId)
            return "Organization items can only apply to folders of the same organization";
        return null;
    }
    return "Unknown binding kind";
};

const validateBindings = async ({ accountId, organizationId = null }, bindings = []) => {
    const owner = { accountId, organizationId: organizationId ? Number(organizationId) : null };
    for (const binding of bindings) {
        const message = await bindingProblem(owner, binding);
        if (message) return { valid: false, message };
    }
    return { valid: true };
};

const setBindings = async (itemId, bindings = []) => {
    const rows = new Map();
    for (const { kind, targetId } of bindings) rows.set(`${kind}:${Number(targetId)}`, { itemId, kind, targetId: Number(targetId) });

    await db.transaction(async (transaction) => {
        await VaultBinding.destroy({ where: { itemId }, transaction });
        if (rows.size) await VaultBinding.bulkCreate([...rows.values()], { transaction });
    });
};

module.exports = { removeBindings, validateBindings, setBindings };

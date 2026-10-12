const { Op } = require("sequelize");
const VaultSshHostKey = require("../../models/VaultSshHostKey");
const Entry = require("../../models/Entry");
const { validateEntryAccess, resolveEntryScope } = require("../../controllers/entry");
const { Permission } = require("../../permissions/registry");
const { HIDDEN, normalizeHost, targetRefsOf, parseTargetRef } = require("./sshRefs");

const usableSshServer = async (accountId, organizationId, entryId) => {
    const entry = await Entry.findByPk(entryId);
    if (entry?.type !== "server" || entry.config?.protocol !== "ssh" || !entry.config?.ip) return null;
    if (organizationId && (await resolveEntryScope(entry)).organizationId !== Number(organizationId)) return null;
    return (await validateEntryAccess(accountId, entry, undefined, Permission.CONNECT_SSH)).valid ? entry : null;
};

const pinnedKey = async (itemId, ref, { transaction } = {}) => {
    const row = await VaultSshHostKey.findOne({ where: { itemId, target: ref }, transaction });
    return row
        ? { algorithm: row.algorithm, fingerprint: row.fingerprint, confirmedAt: row.confirmedAt, confirmedBy: row.confirmedBy ?? null }
        : null;
};

const pinnedRefs = async (itemIds) => new Set((await VaultSshHostKey.findAll({ where: { itemId: itemIds }, attributes: ["itemId", "target"] }))
    .map((row) => `${row.itemId} ${row.target}`));

// A key pinned meanwhile by another call stays; the caller compares the returned fingerprint with its own.
const pinKey = async ({ itemId, ref, algorithm, fingerprint, accountId, transaction }) => {
    try {
        await VaultSshHostKey.create({
            itemId, target: ref, algorithm, fingerprint, confirmedBy: accountId ?? null, confirmedAt: new Date(),
        }, { transaction });
    } catch (error) {
        if (error.name !== "SequelizeUniqueConstraintError") throw error;
    }
    return pinnedKey(itemId, ref, { transaction });
};

const forgetKey = async (itemId, ref) => (await VaultSshHostKey.destroy({ where: { itemId, target: ref } })) > 0;

const dropKeysExcept = (itemId, refs, { transaction } = {}) => VaultSshHostKey.destroy({
    where: { itemId, ...(refs.length ? { target: { [Op.notIn]: refs } } : {}) },
    transaction,
});

module.exports = {
    HIDDEN, normalizeHost, targetRefsOf, parseTargetRef, usableSshServer, pinnedKey, pinnedRefs, pinKey, forgetKey, dropKeysExcept,
};

const VaultSecret = require("../../models/VaultSecret");
const { encryptValue, decryptValue } = require("./crypto");
const { VaultError, VaultErrorCode } = require("./errors");
const logger = require("../../utils/logger");

const aadFor = (itemId, field) => `vault:${itemId}:${field}`;

const unreadable = new Set();

const afterCommit = (transaction, fn) => (transaction ? transaction.afterCommit(fn) : fn());

const writeSecret = async (itemId, field, value, { transaction } = {}) => {
    const { encrypted, iv, authTag } = encryptValue(value, aadFor(itemId, field));
    await VaultSecret.upsert(
        { itemId, field, valueEncrypted: encrypted, valueIV: iv, valueAuthTag: authTag },
        { conflictFields: ["itemId", "field"], transaction },
    );
    afterCommit(transaction, () => unreadable.delete(Number(itemId)));
};

const readSecret = async (itemId, field) => {
    const row = await VaultSecret.findOne({ where: { itemId, field } });
    if (!row) return null;
    try {
        return decryptValue({ encrypted: row.valueEncrypted, iv: row.valueIV, authTag: row.valueAuthTag }, aadFor(row.itemId, row.field));
    } catch {
        logger.error("Vault secret could not be decrypted", { itemId: row.itemId, field: row.field });
        unreadable.add(Number(row.itemId));
        throw new VaultError(VaultErrorCode.ITEM_UNREADABLE, undefined, { itemId: row.itemId });
    }
};

const clearSecrets = async (itemId, { transaction } = {}) => {
    const removed = await VaultSecret.destroy({ where: { itemId }, transaction });
    afterCommit(transaction, () => unreadable.delete(Number(itemId)));
    return removed;
};

const isUnreadable = (itemId) => unreadable.has(Number(itemId));

const listSecretFields = async (itemId) =>
    (await VaultSecret.findAll({ where: { itemId }, attributes: ["field"], order: [["field", "ASC"]] })).map((row) => row.field);

module.exports = { writeSecret, readSecret, clearSecrets, listSecretFields, isUnreadable };

const VaultSettings = require("../../models/VaultSettings");
const VaultSecret = require("../../models/VaultSecret");
const { encryptValue, decryptValue, hasValidKey } = require("./crypto");
const { sendError } = require("../../utils/error");
const logger = require("../../utils/logger");

const KEYCHECK_PLAINTEXT = "outpost-vault";
const KEYCHECK_AAD = "vault:keycheck";

let keyStatus = "missing";

const decrypts = (sealed, aad, expected) => {
    try {
        const plaintext = decryptValue(sealed, aad);
        return expected === undefined || plaintext === expected;
    } catch {
        return false;
    }
};

const checkStoredKey = (settings) =>
    decrypts({ encrypted: settings.keyCheck, iv: settings.keyCheckIV, authTag: settings.keyCheckAuthTag }, KEYCHECK_AAD, KEYCHECK_PLAINTEXT);

// A changed key only locks data that exists: without stored values nothing is lost by adopting it.
const storedValuesReadable = async () => {
    const row = await VaultSecret.findOne({ order: [["id", "ASC"]] });
    return !row || decrypts({ encrypted: row.valueEncrypted, iv: row.valueIV, authTag: row.valueAuthTag }, `vault:${row.itemId}:${row.field}`);
};

const writeKeyCheck = async (settings) => {
    const { encrypted, iv, authTag } = encryptValue(KEYCHECK_PLAINTEXT, KEYCHECK_AAD);
    await settings.update({ keyCheck: encrypted.toString("hex"), keyCheckIV: iv, keyCheckAuthTag: authTag });
};

const initVaultState = async () => {
    if (!hasValidKey()) {
        keyStatus = "missing";
        if (process.env.VAULT_KEY) logger.warn("VAULT_KEY is not 64 hex characters; the vault stays off");
        else logger.system("No VAULT_KEY set; the vault stays off");
        return { keyStatus };
    }
    const settings = await VaultSettings.getOrCreate();
    if (settings.keyCheck && checkStoredKey(settings)) {
        keyStatus = "active";
    } else if (!settings.keyCheck || await storedValuesReadable()) {
        if (settings.keyCheck) logger.warn("VAULT_KEY changed while no stored value depends on the old key; the check value is rewritten");
        await writeKeyCheck(settings);
        keyStatus = "active";
    } else {
        keyStatus = "mismatch";
    }
    if (keyStatus === "mismatch") logger.error("VAULT_KEY does not match the stored vault data; the vault stays off");
    else logger.system("Vault enabled");
    return { keyStatus };
};

const getKeyStatus = () => keyStatus;

const isVaultEnabled = () => keyStatus === "active";

const requireVaultEnabled = (req, res, next) => {
    if (!isVaultEnabled()) return sendError(res, 404, 404, "Not found");
    next();
};

const _resetForTests = () => {
    keyStatus = "missing";
};

module.exports = { initVaultState, getKeyStatus, isVaultEnabled, requireVaultEnabled, _resetForTests };

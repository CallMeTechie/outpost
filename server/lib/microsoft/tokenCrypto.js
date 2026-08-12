const { encrypt, decrypt } = require("../../utils/encryption");
const logger = require("../../utils/logger");

const MASKED_SECRET = "********";

// Deliberately not a Sequelize hook. The database is configured with `query: { raw: true }`, so
// every find returns a plain object without save(); writes go through Model.update(), and
// Model.update does not fire beforeUpdate (only beforeBulkUpdate). A hook-based design would
// silently store plaintext on every update. Sealing is therefore explicit at each call site.
const seal = (field, value) => {
    const encrypted = encrypt(value);
    return {
        [field]: encrypted.encrypted,
        [`${field}IV`]: encrypted.iv,
        [`${field}AuthTag`]: encrypted.authTag,
    };
};

const open = (field, row, label) => {
    if (!row || !row[field]) return null;

    try {
        return decrypt(row[field], row[`${field}IV`], row[`${field}AuthTag`]);
    } catch (error) {
        logger.error(`Failed to decrypt ${label}`, { error: error.message });
        return null;
    }
};

const sealRefreshToken = (token) => seal("refreshToken", token);
const openRefreshToken = (row) => open("refreshToken", row, "a Microsoft refresh token");

const sealClientSecret = (secret) => seal("clientSecret", secret);
const openClientSecret = (row) => open("clientSecret", row, "the Microsoft client secret");

module.exports = { MASKED_SECRET, sealRefreshToken, openRefreshToken, sealClientSecret, openClientSecret };

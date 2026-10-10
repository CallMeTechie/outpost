const crypto = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

const hasValidKey = () => KEY_PATTERN.test(process.env.VAULT_KEY ?? "");

const vaultKey = () => {
    if (!hasValidKey()) throw new Error("VAULT_KEY is missing or not 64 hex characters");
    return Buffer.from(process.env.VAULT_KEY, "hex");
};

const encryptValue = (plaintext, aad) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, vaultKey(), iv);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    return { encrypted, iv: iv.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
};

const decryptValue = ({ encrypted, iv, authTag }, aad) => {
    // Without authTagLength, GCM accepts a truncated tag and checks only its prefix.
    const decipher = crypto.createDecipheriv(ALGORITHM, vaultKey(), Buffer.from(iv, "hex"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(authTag, "hex"));
    const data = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted, "hex");
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};

module.exports = { encryptValue, decryptValue, hasValidKey };

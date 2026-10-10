const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("api_keys", {
    accountId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
            model: "accounts",
            key: "id",
        },
        onDelete: "CASCADE",
    },
    name: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    tokenHash: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
    },
    prefix: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    lastUsedAt: {
        type: Sequelize.DATE,
        allowNull: true,
    },
    expiresAt: {
        type: Sequelize.DATE,
        allowNull: true,
    },
    kind: { type: Sequelize.STRING, allowNull: false, defaultValue: "account" },
    pending: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    entryId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "entries", key: "id" },
        onDelete: "CASCADE",
    },
    agentType: { type: Sequelize.STRING, allowNull: true },
    ipBinding: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
    allowedCidrs: { type: Sequelize.JSON, allowNull: true },
    identityId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "identities", key: "id" },
        onDelete: "SET NULL",
    },
    remoteUser: { type: Sequelize.STRING, allowNull: true },
    seenIp: { type: Sequelize.STRING, allowNull: true },
    seenIpAdopted: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    agentUrl: { type: Sequelize.STRING(2048), allowNull: true },
}, {
    freezeTableName: true,
    timestamps: true,
    updatedAt: false,
    hooks: {
        afterFind: (results) => {
            const normalize = (key) => {
                if (!key) return;
                if (typeof key.allowedCidrs === "string") {
                    try { key.allowedCidrs = JSON.parse(key.allowedCidrs); } catch { key.allowedCidrs = []; }
                }
                for (const flag of ["pending", "ipBinding", "seenIpAdopted"]) {
                    if (typeof key[flag] === "number") key[flag] = key[flag] === 1;
                }
            };
            Array.isArray(results) ? results.forEach(normalize) : normalize(results);
        },
    },
});

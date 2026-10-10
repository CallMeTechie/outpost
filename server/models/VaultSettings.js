const Sequelize = require("sequelize");
const db = require("../utils/database");

const VaultSettings = db.define("vault_settings", {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    agentUrl: { type: Sequelize.STRING, allowNull: true },
    keyCheck: { type: Sequelize.TEXT, allowNull: true },
    keyCheckIV: { type: Sequelize.STRING, allowNull: true },
    keyCheckAuthTag: { type: Sequelize.STRING, allowNull: true },
    createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
    updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
}, { freezeTableName: true });

// Same reasoning as BrowserSettings.getOrCreate: findOrCreate fails with SQLITE_BUSY on two concurrent first calls.
VaultSettings.getOrCreate = async () => {
    const existing = await VaultSettings.findByPk(1, { raw: false });
    if (existing) return existing;
    await VaultSettings.bulkCreate([{ id: 1 }], { ignoreDuplicates: true });
    return VaultSettings.findByPk(1, { raw: false });
};

module.exports = VaultSettings;

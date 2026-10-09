const Sequelize = require("sequelize");
const db = require("../utils/database");

const BrowserSettings = db.define("browser_settings", {
    id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
    enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    launcherUrl: { type: Sequelize.STRING, allowNull: false, defaultValue: "http://outpost-browser:9300" },
    callbackHost: { type: Sequelize.STRING, allowNull: false, defaultValue: "outpost" },
    maxSessions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 4 },
    idleMinutes: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 30 },
    createdAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
    updatedAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
});

// Not findOrCreate: on SQLite two concurrent first calls fail with SQLITE_BUSY inside its transaction.
// With a fixed id, INSERT OR IGNORE lets the slower call find the faster one's row.
BrowserSettings.getOrCreate = async () => {
    const existing = await BrowserSettings.findByPk(1, { raw: false });
    if (existing) return existing;
    await BrowserSettings.bulkCreate([{ id: 1 }], { ignoreDuplicates: true });
    return BrowserSettings.findByPk(1, { raw: false });
};

module.exports = BrowserSettings;

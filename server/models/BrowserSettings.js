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

BrowserSettings.getOrCreate = async () => (await BrowserSettings.findOne()) ?? BrowserSettings.create({});

module.exports = BrowserSettings;

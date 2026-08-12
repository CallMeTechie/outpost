const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("microsoft_connections", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, allowNull: false, primaryKey: true },
    accountId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "accounts", key: "id" },
        onDelete: "CASCADE",
    },
    displayName: { type: Sequelize.STRING, allowNull: false },
    microsoftAccountId: { type: Sequelize.STRING, allowNull: false },
    microsoftEmail: { type: Sequelize.STRING, allowNull: true },
    refreshToken: { type: Sequelize.STRING, allowNull: true },
    refreshTokenIV: { type: Sequelize.STRING, allowNull: true },
    refreshTokenAuthTag: { type: Sequelize.STRING, allowNull: true },
    grantedScopes: { type: Sequelize.STRING, allowNull: true },
    status: { type: Sequelize.STRING, allowNull: false, defaultValue: "connected" },
    lastRefreshAt: { type: Sequelize.DATE, allowNull: true },
}, {
    freezeTableName: true,
    timestamps: true,
    updatedAt: false,
});

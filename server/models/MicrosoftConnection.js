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
    // TEXT, not STRING: the ciphertext is hex-encoded, so a VARCHAR(255) would hold at most 127
    // plaintext bytes. Microsoft refresh tokens are several hundred bytes to several kilobytes, and
    // on MySQL the write would either fail or truncate — a truncated value then fails its GCM auth
    // tag, which reads as "no usable token" after the old refresh token has already been spent.
    // The IV and auth tag stay STRING: both are fixed 32-character hex.
    refreshToken: { type: Sequelize.TEXT, allowNull: true },
    refreshTokenIV: { type: Sequelize.STRING, allowNull: true },
    refreshTokenAuthTag: { type: Sequelize.STRING, allowNull: true },
    grantedScopes: { type: Sequelize.TEXT, allowNull: true },
    status: { type: Sequelize.STRING, allowNull: false, defaultValue: "connected" },
    lastRefreshAt: { type: Sequelize.DATE, allowNull: true },
}, {
    freezeTableName: true,
    timestamps: true,
    updatedAt: false,
});

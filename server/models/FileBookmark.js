const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("file_bookmarks", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
    accountId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "accounts", key: "id" },
        onDelete: "CASCADE",
    },
    entryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "entries", key: "id" },
        onDelete: "CASCADE",
    },
    name: { type: Sequelize.STRING, allowNull: false },
    path: { type: Sequelize.STRING(1024), allowNull: false },
    pathHash: { type: Sequelize.STRING(64), allowNull: false },
    position: { type: Sequelize.INTEGER, allowNull: false },
}, {
    freezeTableName: true,
    timestamps: true,
    indexes: [{ unique: true, fields: ["accountId", "entryId", "pathHash"] }],
});

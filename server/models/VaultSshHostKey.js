const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("vault_ssh_host_keys", {
    itemId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "vault_items", key: "id" },
        onDelete: "CASCADE",
    },
    target: { type: Sequelize.STRING(300), allowNull: false },
    algorithm: { type: Sequelize.STRING(40), allowNull: false },
    fingerprint: { type: Sequelize.STRING(60), allowNull: false },
    confirmedBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "accounts", key: "id" },
        onDelete: "SET NULL",
    },
    confirmedAt: { type: Sequelize.DATE, allowNull: false },
}, {
    freezeTableName: true,
    timestamps: false,
    indexes: [{ unique: true, fields: ["itemId", "target"], name: "vault_ssh_host_keys_item_target_unique" }],
});

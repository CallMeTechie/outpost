const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("vault_bindings", {
    itemId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "vault_items", key: "id" },
        onDelete: "CASCADE",
    },
    kind: { type: Sequelize.STRING(16), allowNull: false },
    // Points at entries, folders or tags depending on kind, so no foreign key; deleteEntry/deleteFolder/deleteTag remove bindings.
    targetId: { type: Sequelize.INTEGER, allowNull: false },
}, {
    freezeTableName: true,
    timestamps: false,
    indexes: [{ unique: true, fields: ["itemId", "kind", "targetId"], name: "vault_bindings_item_kind_target_unique" }],
});

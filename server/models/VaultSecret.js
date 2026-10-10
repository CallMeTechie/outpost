const Sequelize = require("sequelize");
const db = require("../utils/database");

// No afterFind hook as in Credential: only server/lib/vault/secrets.js decrypts, so lists and includes never carry plaintext.
module.exports = db.define("vault_secrets", {
    itemId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "vault_items", key: "id" },
        onDelete: "CASCADE",
    },
    field: { type: Sequelize.STRING(32), allowNull: false },
    valueEncrypted: { type: Sequelize.BLOB, allowNull: false },
    valueIV: { type: Sequelize.STRING, allowNull: false },
    valueAuthTag: { type: Sequelize.STRING, allowNull: false },
}, {
    freezeTableName: true,
    timestamps: false,
    indexes: [{ unique: true, fields: ["itemId", "field"], name: "vault_secrets_item_field_unique" }],
});

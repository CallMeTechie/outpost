const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("vault_items", {
    accountId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "accounts", key: "id" },
        onDelete: "CASCADE",
    },
    organizationId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "organizations", key: "id" },
        onDelete: "CASCADE",
    },
    name: { type: Sequelize.STRING(64), allowNull: false },
    type: { type: Sequelize.STRING(16), allowNull: false },
    description: { type: Sequelize.TEXT, allowNull: true },
    fields: { type: Sequelize.JSON, allowNull: false },
    approvalRequired: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
    allServers: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
    createdBy: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "accounts", key: "id" },
        onDelete: "SET NULL",
    },
    lastUsedAt: { type: Sequelize.DATE, allowNull: true },
}, {
    freezeTableName: true,
    timestamps: true,
    indexes: [
        { unique: true, fields: ["accountId", "name"], name: "vault_items_account_name_unique" },
        { unique: true, fields: ["organizationId", "name"], name: "vault_items_organization_name_unique" },
    ],
    hooks: {
        afterFind: (results) => {
            const normalize = (item) => {
                if (!item) return;
                if (typeof item.fields === "string") {
                    try { item.fields = JSON.parse(item.fields); } catch {}
                }
                for (const flag of ["approvalRequired", "allServers"]) {
                    if (typeof item[flag] === "number") item[flag] = item[flag] === 1;
                }
            };
            Array.isArray(results) ? results.forEach(normalize) : normalize(results);
        },
    },
});

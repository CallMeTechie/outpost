module.exports = {
    async up(queryInterface, Sequelize) {
        const { STRING, INTEGER, DATE } = Sequelize;
        const tables = (await queryInterface.showAllTables()).map((t) => t.toLowerCase?.() || t);
        if (!tables.includes("vault_items")) return;

        if (!tables.includes("vault_ssh_host_keys")) {
            await queryInterface.createTable("vault_ssh_host_keys", {
                id: { type: INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
                itemId: { type: INTEGER, allowNull: false, references: { model: "vault_items", key: "id" }, onDelete: "CASCADE" },
                target: { type: STRING(300), allowNull: false },
                algorithm: { type: STRING(40), allowNull: false },
                fingerprint: { type: STRING(60), allowNull: false },
                confirmedBy: { type: INTEGER, allowNull: true, references: { model: "accounts", key: "id" }, onDelete: "SET NULL" },
                confirmedAt: { type: DATE, allowNull: false },
            });
        }
        const indexes = await queryInterface.showIndex("vault_ssh_host_keys");
        if (!indexes.some((i) => i.name === "vault_ssh_host_keys_item_target_unique"))
            await queryInterface.addIndex("vault_ssh_host_keys", ["itemId", "target"], { unique: true, name: "vault_ssh_host_keys_item_target_unique" });
    },
};

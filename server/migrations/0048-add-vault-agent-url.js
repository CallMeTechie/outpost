module.exports = {
    async up(queryInterface, Sequelize) {
        const { STRING, BOOLEAN } = Sequelize;
        const tables = (await queryInterface.showAllTables()).map((t) => t.toLowerCase?.() || t);

        const addMissing = async (table, columns) => {
            if (!tables.includes(table)) return;
            const existing = await queryInterface.describeTable(table);
            for (const [name, definition] of Object.entries(columns)) {
                if (!existing[name]) await queryInterface.addColumn(table, name, definition);
            }
        };

        await addMissing("api_keys", { agentUrl: { type: STRING(2048), allowNull: true } });
        await addMissing("vault_settings", { ipBindingDefault: { type: BOOLEAN, allowNull: false, defaultValue: true } });
        // 0047 created it as VARCHAR(255) while the validation allows 2048; SQLite does not enforce the length.
        if (queryInterface.sequelize.options.dialect === "mysql" && tables.includes("vault_settings"))
            await queryInterface.changeColumn("vault_settings", "agentUrl", { type: STRING(2048), allowNull: true });
    },
};

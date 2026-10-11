module.exports = {
    async up(queryInterface, Sequelize) {
        const tables = (await queryInterface.showAllTables()).map((t) => t.toLowerCase?.() || t);
        if (!tables.includes("vault_settings")) return;
        const existing = await queryInterface.describeTable("vault_settings");
        if (!existing.fillAnywhere)
            await queryInterface.addColumn("vault_settings", "fillAnywhere", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    },
};

module.exports = {
    async up(queryInterface, Sequelize) {
        const { STRING, TEXT, INTEGER } = Sequelize;

        // Guarded per column: the runner records a migration only after `up` returns, so a crash
        // between two addColumn calls leaves it pending and the rerun must skip what already exists.
        const tables = (await queryInterface.showAllTables()).map((t) => t.toLowerCase?.() ?? t);

        const addMissing = async (table, columns) => {
            if (!tables.includes(table)) return;
            const existing = await queryInterface.describeTable(table);
            for (const [name, type] of Object.entries(columns)) {
                if (!existing[name]) await queryInterface.addColumn(table, name, { type, allowNull: true });
            }
        };

        await addMissing("oidc_providers", { endSessionEndpoint: STRING });
        await addMissing("sessions", {
            oidcProviderId: INTEGER,
            // An ID token easily exceeds 255 bytes and is stored hex-encoded; VARCHAR would truncate it on MySQL.
            oidcIdTokenEncrypted: TEXT,
            oidcIdTokenIV: STRING,
            oidcIdTokenAuthTag: STRING,
        });
    },
};

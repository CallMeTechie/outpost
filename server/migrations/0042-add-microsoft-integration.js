module.exports = {
    async up(queryInterface, Sequelize) {
        const { STRING, INTEGER, BOOLEAN, DATE } = Sequelize;

        const tables = (await queryInterface.showAllTables()).map(t => t.toLowerCase?.() || t);

        if (!tables.includes("microsoft_apps")) {
            await queryInterface.createTable("microsoft_apps", {
                id: { type: INTEGER, primaryKey: true, autoIncrement: true },
                clientId: { type: STRING, allowNull: false },
                clientSecret: { type: STRING, allowNull: true },
                clientSecretIV: { type: STRING, allowNull: true },
                clientSecretAuthTag: { type: STRING, allowNull: true },
                redirectUri: { type: STRING, allowNull: false },
                enabled: { type: BOOLEAN, allowNull: false, defaultValue: false },
            });
        }

        if (!tables.includes("microsoft_connections")) {
            await queryInterface.createTable("microsoft_connections", {
                id: { type: INTEGER, primaryKey: true, autoIncrement: true },
                accountId: {
                    type: INTEGER,
                    allowNull: false,
                    references: { model: "accounts", key: "id" },
                    onDelete: "CASCADE",
                },
                displayName: { type: STRING, allowNull: false },
                microsoftAccountId: { type: STRING, allowNull: false },
                microsoftEmail: { type: STRING, allowNull: true },
                refreshToken: { type: STRING, allowNull: true },
                refreshTokenIV: { type: STRING, allowNull: true },
                refreshTokenAuthTag: { type: STRING, allowNull: true },
                grantedScopes: { type: STRING, allowNull: true },
                status: { type: STRING, allowNull: false, defaultValue: "connected" },
                lastRefreshAt: { type: DATE, allowNull: true },
                createdAt: { type: DATE, allowNull: false },
            });

            // The same Microsoft account connected twice must update the existing row, never add a
            // second one. The index makes that a rule of the schema, not only of the controller.
            await queryInterface.addIndex("microsoft_connections", ["accountId", "microsoftAccountId"], {
                unique: true,
                name: "microsoft_connections_account_unique",
            });
        }
    },
};

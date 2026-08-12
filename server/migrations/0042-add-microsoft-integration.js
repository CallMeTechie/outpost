module.exports = {
    async up(queryInterface, Sequelize) {
        const { STRING, TEXT, INTEGER, BOOLEAN, DATE } = Sequelize;

        const tables = (await queryInterface.showAllTables()).map(t => t.toLowerCase?.() || t);

        if (!tables.includes("microsoft_apps")) {
            await queryInterface.createTable("microsoft_apps", {
                id: { type: INTEGER, primaryKey: true, autoIncrement: true },
                clientId: { type: STRING, allowNull: false },
                // Hex-encoded ciphertext is twice the plaintext length, so VARCHAR(255) would cap
                // the secret at 127 bytes. TEXT here and in the model; IV and auth tag are fixed
                // 32-character hex and stay STRING.
                clientSecret: { type: TEXT, allowNull: true },
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
                // A Microsoft refresh token runs from several hundred bytes to several kilobytes and
                // is stored hex-encoded, which doubles it. VARCHAR(255) would truncate it on MySQL,
                // and a truncated token fails its GCM auth tag after the old one has been spent.
                refreshToken: { type: TEXT, allowNull: true },
                refreshTokenIV: { type: STRING, allowNull: true },
                refreshTokenAuthTag: { type: STRING, allowNull: true },
                grantedScopes: { type: TEXT, allowNull: true },
                status: { type: STRING, allowNull: false, defaultValue: "connected" },
                lastRefreshAt: { type: DATE, allowNull: true },
                createdAt: { type: DATE, allowNull: false },
            });
        }

        // The same Microsoft account connected twice must update the existing row, never add a
        // second one. The index makes that a rule of the schema, not only of the controller.
        //
        // Deliberately outside the createTable guard: a crash between creating the table and
        // creating the index leaves the migration unrecorded, and on the rerun the table already
        // exists — inside the guard the index would be skipped for good while migrationRunner
        // records the rerun as successful. The existence check keeps the rerun idempotent for the
        // case where the crash happened after the index was already created.
        const indexes = await queryInterface.showIndex("microsoft_connections");
        if (!indexes.some(index => index.name === "microsoft_connections_account_unique")) {
            await queryInterface.addIndex("microsoft_connections", ["accountId", "microsoftAccountId"], {
                unique: true,
                name: "microsoft_connections_account_unique",
            });
        }
    },
};

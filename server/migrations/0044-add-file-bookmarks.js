const { DataTypes } = require("sequelize");

module.exports = {
    async up(queryInterface) {
        // Guarded per table, not per migration: the runner records a migration only after `up`
        // returns (utils/migrationRunner.js), so a failure between the two createTable calls leaves
        // it pending and it runs again on the next start. Without the guard that second run dies on
        // "table already exists" and the server never comes up. Same shape as
        // 0042-add-microsoft-integration.js.
        const tables = (await queryInterface.showAllTables()).map((t) => t.toLowerCase?.() ?? t);
        // PRAGMA is a syntax error on MySQL, and server/utils/database.js serves both dialects.
        // 0039-drop-script-timestamps.js branches the same way.
        const isSqlite = queryInterface.sequelize.getDialect() === "sqlite";
        if (isSqlite) await queryInterface.sequelize.query("PRAGMA foreign_keys = OFF");

        try {
            if (!tables.includes("file_bookmarks")) {
                await queryInterface.createTable("file_bookmarks", {
                    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
                    accountId: {
                        type: DataTypes.INTEGER, allowNull: false,
                        references: { model: "accounts", key: "id" }, onDelete: "CASCADE",
                    },
                    entryId: {
                        type: DataTypes.INTEGER, allowNull: false,
                        references: { model: "entries", key: "id" }, onDelete: "CASCADE",
                    },
                    name: { type: DataTypes.STRING, allowNull: false },
                    path: { type: DataTypes.STRING(1024), allowNull: false },
                    pathHash: { type: DataTypes.STRING(64), allowNull: false },
                    position: { type: DataTypes.INTEGER, allowNull: false },
                    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
                    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
                });
            }

            // Indexes guarded separately: a run that created the table and then failed on the index
            // would skip the index forever, and "this folder is already bookmarked" would stop being
            // enforced by the database at all.
            const bookmarkIndexes = await queryInterface.showIndex("file_bookmarks");
            if (!bookmarkIndexes.some((i) => i.name === "file_bookmarks_account_entry_path_unique")) {
                // Hash, not path: a composite index over VARCHAR(1024) exceeds InnoDB's 3072-byte
                // limit under utf8mb4, and VARCHAR(255) would be shorter than the 4096 bytes the
                // engine lets through.
                await queryInterface.addIndex("file_bookmarks", ["accountId", "entryId", "pathHash"], {
                    unique: true, name: "file_bookmarks_account_entry_path_unique",
                });
            }

            if (!tables.includes("file_pane_states")) {
                await queryInterface.createTable("file_pane_states", {
                    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
                    accountId: {
                        type: DataTypes.INTEGER, allowNull: false,
                        references: { model: "accounts", key: "id" }, onDelete: "CASCADE",
                    },
                    entryId: {
                        type: DataTypes.INTEGER, allowNull: false,
                        references: { model: "entries", key: "id" }, onDelete: "CASCADE",
                    },
                    // Deliberately NOT a foreign key on identities, and deliberately not nullable:
                    // 0 means "ad-hoc credentials, no stored identity". A foreign key would be
                    // violated by every such row, and a nullable column would make the unique index
                    // below stop biting - both dialects treat NULL as distinct from NULL there.
                    identityId: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
                    lastPath: { type: DataTypes.STRING(1024), allowNull: false },
                    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
                    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
                });
            }

            const paneIndexes = await queryInterface.showIndex("file_pane_states");
            if (!paneIndexes.some((i) => i.name === "file_pane_states_account_entry_identity_unique")) {
                await queryInterface.addIndex("file_pane_states", ["accountId", "entryId", "identityId"], {
                    unique: true, name: "file_pane_states_account_entry_identity_unique",
                });
            }
        } finally {
            if (isSqlite) await queryInterface.sequelize.query("PRAGMA foreign_keys = ON");
        }
    },
};

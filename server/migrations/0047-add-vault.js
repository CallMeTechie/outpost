module.exports = {
    async up(queryInterface, Sequelize) {
        const { STRING, TEXT, INTEGER, BOOLEAN, DATE, BLOB } = Sequelize;

        // Guarded per table, column and index: the runner records a migration only after `up` returns,
        // so a crash halfway leaves it pending and the rerun must skip what already exists.
        const tables = (await queryInterface.showAllTables()).map((t) => t.toLowerCase?.() ?? t);

        const createMissing = async (table, columns) => {
            if (!tables.includes(table)) await queryInterface.createTable(table, columns);
        };
        const uniqueMissing = async (table, fields, name) => {
            const indexes = await queryInterface.showIndex(table);
            if (!indexes.some((i) => i.name === name)) await queryInterface.addIndex(table, fields, { unique: true, name });
        };
        const addMissing = async (table, columns) => {
            if (!tables.includes(table)) return;
            const existing = await queryInterface.describeTable(table);
            for (const [name, definition] of Object.entries(columns)) {
                if (!existing[name]) await queryInterface.addColumn(table, name, definition);
            }
        };

        await createMissing("vault_items", {
            id: { type: INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            accountId: { type: INTEGER, allowNull: true, references: { model: "accounts", key: "id" }, onDelete: "CASCADE" },
            organizationId: { type: INTEGER, allowNull: true, references: { model: "organizations", key: "id" }, onDelete: "CASCADE" },
            name: { type: STRING(64), allowNull: false },
            type: { type: STRING(16), allowNull: false },
            description: { type: TEXT, allowNull: true },
            fields: { type: Sequelize.JSON, allowNull: false },
            approvalRequired: { type: BOOLEAN, allowNull: false, defaultValue: true },
            allServers: { type: BOOLEAN, allowNull: false, defaultValue: false },
            createdBy: { type: INTEGER, allowNull: true, references: { model: "accounts", key: "id" }, onDelete: "SET NULL" },
            lastUsedAt: { type: DATE, allowNull: true },
            createdAt: { type: DATE, allowNull: false, defaultValue: Sequelize.NOW },
            updatedAt: { type: DATE, allowNull: false, defaultValue: Sequelize.NOW },
        });
        await uniqueMissing("vault_items", ["accountId", "name"], "vault_items_account_name_unique");
        await uniqueMissing("vault_items", ["organizationId", "name"], "vault_items_organization_name_unique");

        await createMissing("vault_secrets", {
            id: { type: INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            itemId: { type: INTEGER, allowNull: false, references: { model: "vault_items", key: "id" }, onDelete: "CASCADE" },
            field: { type: STRING(32), allowNull: false },
            valueEncrypted: { type: BLOB, allowNull: false },
            valueIV: { type: STRING, allowNull: false },
            valueAuthTag: { type: STRING, allowNull: false },
        });
        await uniqueMissing("vault_secrets", ["itemId", "field"], "vault_secrets_item_field_unique");

        await createMissing("vault_bindings", {
            id: { type: INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            itemId: { type: INTEGER, allowNull: false, references: { model: "vault_items", key: "id" }, onDelete: "CASCADE" },
            kind: { type: STRING(16), allowNull: false },
            targetId: { type: INTEGER, allowNull: false },
        });
        await uniqueMissing("vault_bindings", ["itemId", "kind", "targetId"], "vault_bindings_item_kind_target_unique");

        await createMissing("vault_settings", {
            id: { type: INTEGER, primaryKey: true, autoIncrement: true },
            agentUrl: { type: STRING, allowNull: true },
            // Hex-encoded ciphertext; TEXT like oidcIdTokenEncrypted in 0045, so MySQL never truncates it.
            keyCheck: { type: TEXT, allowNull: true },
            keyCheckIV: { type: STRING, allowNull: true },
            keyCheckAuthTag: { type: STRING, allowNull: true },
            createdAt: { type: DATE, allowNull: true },
            updatedAt: { type: DATE, allowNull: true },
        });

        await addMissing("api_keys", {
            kind: { type: STRING, allowNull: false, defaultValue: "account" },
            pending: { type: BOOLEAN, allowNull: false, defaultValue: false },
            entryId: { type: INTEGER, allowNull: true, references: { model: "entries", key: "id" }, onDelete: "CASCADE" },
            agentType: { type: STRING, allowNull: true },
            ipBinding: { type: BOOLEAN, allowNull: false, defaultValue: true },
            allowedCidrs: { type: Sequelize.JSON, allowNull: true },
            identityId: { type: INTEGER, allowNull: true, references: { model: "identities", key: "id" }, onDelete: "SET NULL" },
            remoteUser: { type: STRING, allowNull: true },
            seenIp: { type: STRING, allowNull: true },
            seenIpAdopted: { type: BOOLEAN, allowNull: false, defaultValue: false },
        });
        await addMissing("sessions", { impersonatorId: { type: INTEGER, allowNull: true } });
    },
};

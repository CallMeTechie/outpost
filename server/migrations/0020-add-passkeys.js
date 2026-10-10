const { DataTypes } = require("sequelize");

module.exports = {
    async up(queryInterface) {
        const isMysql = queryInterface.sequelize.options.dialect === 'mysql';

        if (isMysql) {
            await queryInterface.sequelize.query("SET FOREIGN_KEY_CHECKS = 0");
        } else {
            await queryInterface.sequelize.query("PRAGMA foreign_keys = OFF");
        }

        await queryInterface.createTable("passkeys", {
            id: { 
                type: DataTypes.INTEGER, 
                autoIncrement: true, 
                primaryKey: true, 
                allowNull: false 
            },
            // MySQL cannot index TEXT. A WebAuthn credential ID is at most 1023 bytes, i.e. 1364
            // base64url characters; ascii_bin keeps the index under 3072 bytes and compares case-sensitively.
            credentialId: isMysql
                ? { type: "VARCHAR(1364) CHARACTER SET ascii COLLATE ascii_bin", allowNull: false }
                : { type: DataTypes.TEXT, allowNull: false, unique: true },
            credentialPublicKey: {
                type: DataTypes.TEXT,
                allowNull: false,
            },
            counter: {
                type: DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0,
            },
            credentialDeviceType: {
                type: DataTypes.STRING,
                allowNull: false,
            },
            credentialBackedUp: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: false,
            },
            transports: {
                type: DataTypes.TEXT,
                allowNull: true,
            },
            accountId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: "accounts", key: "id" },
                onDelete: "CASCADE",
            },
            name: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: "Passkey",
            },
            createdAt: { 
                type: DataTypes.DATE, 
                allowNull: false, 
                defaultValue: DataTypes.NOW 
            },
        });

        await queryInterface.addIndex("passkeys", ["accountId"], {
            name: "passkeys_account_id_idx"
        });

        await queryInterface.addIndex("passkeys", ["credentialId"], {
            unique: true,
            name: "passkeys_credential_id_unique"
        });

        if (isMysql) {
            await queryInterface.sequelize.query("SET FOREIGN_KEY_CHECKS = 1");
        } else {
            await queryInterface.sequelize.query("PRAGMA foreign_keys = ON");
        }
    },
};

const test = require("node:test");
const assert = require("node:assert");
const { Sequelize, DataTypes, QueryTypes } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true } });
const databasePath = require.resolve("../../../utils/database");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: db };

const VaultSettings = require("../../../models/VaultSettings");
const migration = require("../../../migrations/0047-add-vault");
const { initVaultState, getKeyStatus, isVaultEnabled, _resetForTests } = require("../state");
const { writeSecret } = require("../secrets");
const { decryptValue } = require("../crypto");

const KEY_A = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const KEY_B = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

test.before(async () => {
    const queryInterface = db.getQueryInterface();
    for (const table of ["accounts", "organizations", "entries", "identities"])
        await queryInterface.createTable(table, { id: { type: DataTypes.INTEGER, primaryKey: true } });
    await queryInterface.createTable("api_keys", {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        accountId: { type: DataTypes.INTEGER, allowNull: false },
        name: { type: DataTypes.STRING, allowNull: false },
        tokenHash: { type: DataTypes.STRING, allowNull: false },
        prefix: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: true },
    });
    await queryInterface.createTable("sessions", { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true } });
    await queryInterface.bulkInsert("api_keys", [{ accountId: 1, name: "ci", tokenHash: "h", prefix: "outpost_0011", createdAt: new Date() }]);
    await migration.up(queryInterface, DataTypes);
    await migration.up(queryInterface, DataTypes);
});

test.afterEach(() => {
    delete process.env.VAULT_KEY;
    _resetForTests();
});

test("migration 0047 runs twice, resumes a half-applied run and turns existing API keys into ordinary account keys", async () => {
    const queryInterface = db.getQueryInterface();
    await queryInterface.removeIndex("vault_bindings", "vault_bindings_item_kind_target_unique");
    await queryInterface.removeColumn("api_keys", "seenIpAdopted");
    await migration.up(queryInterface, DataTypes);

    const [legacy] = await db.query("SELECT kind, pending, ipBinding, seenIpAdopted, entryId FROM api_keys", { type: QueryTypes.SELECT });
    assert.deepStrictEqual(
        [legacy.kind, Boolean(legacy.pending), Boolean(legacy.ipBinding), Boolean(legacy.seenIpAdopted), legacy.entryId],
        ["account", false, true, false, null]);
    assert.ok((await queryInterface.describeTable("api_keys")).seenIpAdopted);
    assert.ok((await queryInterface.describeTable("sessions")).impersonatorId);
    const indexes = (await Promise.all(["vault_items", "vault_secrets", "vault_bindings"].map((t) => queryInterface.showIndex(t))))
        .flat().map((i) => i.name);
    for (const name of ["vault_items_account_name_unique", "vault_items_organization_name_unique",
        "vault_secrets_item_field_unique", "vault_bindings_item_kind_target_unique"])
        assert.ok(indexes.includes(name), name);
});

test("without a key the vault is off; the first start with a key writes the check value; another key switches it off only once values are stored", async () => {
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "missing" });
    process.env.VAULT_KEY = "not-a-key";
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "missing" });
    assert.strictEqual(isVaultEnabled(), false);

    process.env.VAULT_KEY = KEY_A;
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "active" });
    assert.strictEqual(isVaultEnabled(), true);
    const stored = await VaultSettings.findByPk(1);
    assert.strictEqual(decryptValue({ encrypted: stored.keyCheck, iv: stored.keyCheckIV, authTag: stored.keyCheckAuthTag }, "vault:keycheck"), "outpost-vault");
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "active" });

    process.env.VAULT_KEY = KEY_B;
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "active" });
    const rewritten = await VaultSettings.findByPk(1);
    assert.notStrictEqual(rewritten.keyCheck, stored.keyCheck);
    assert.strictEqual(decryptValue({ encrypted: rewritten.keyCheck, iv: rewritten.keyCheckIV, authTag: rewritten.keyCheckAuthTag }, "vault:keycheck"), "outpost-vault");

    await db.getQueryInterface().bulkInsert("vault_items", [{ name: "git", type: "login", fields: "{}", approvalRequired: true, allServers: false, createdAt: new Date(), updatedAt: new Date() }]);
    const [{ id: itemId }] = await db.query("SELECT id FROM vault_items", { type: QueryTypes.SELECT });
    await writeSecret(itemId, "password", "hunter2");

    process.env.VAULT_KEY = KEY_A;
    assert.deepStrictEqual(await initVaultState(), { keyStatus: "mismatch" });
    assert.strictEqual(getKeyStatus(), "mismatch");
    assert.strictEqual(isVaultEnabled(), false);
    assert.strictEqual((await VaultSettings.findByPk(1)).keyCheck, rewritten.keyCheck);
});

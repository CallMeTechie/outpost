process.env.VAULT_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const { Sequelize, DataTypes } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true } });
const databasePath = require.resolve("../../../utils/database");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: db };

const VaultItem = require("../../../models/VaultItem");
const VaultSecret = require("../../../models/VaultSecret");
const { writeSecret, readSecret, clearSecrets, isUnreadable } = require("../secrets");
const { decryptValue } = require("../crypto");
const { VaultError, VaultErrorCode } = require("../errors");

test.before(async () => {
    for (const table of ["accounts", "organizations"])
        await db.getQueryInterface().createTable(table, { id: { type: DataTypes.INTEGER, primaryKey: true } });
    await db.sync();
});

test("a ciphertext only decrypts in its own row and field, and only with the full auth tag; a failed read marks the item until it is rewritten", async () => {
    const login = { username: "deploy", origins: ["https://git.example.com"] };
    const own = await VaultItem.create({ name: "git", type: "login", fields: login });
    const other = await VaultItem.create({ name: "wiki", type: "login", fields: login });
    await writeSecret(own.id, "password", "hunter2");

    const sealed = await VaultSecret.findOne({ where: { itemId: own.id, field: "password" } });
    assert.ok(Buffer.isBuffer(sealed.valueEncrypted) && !sealed.valueEncrypted.includes("hunter2"));
    assert.strictEqual(sealed.valueIV.length, 24);
    const copy = { valueEncrypted: sealed.valueEncrypted, valueIV: sealed.valueIV, valueAuthTag: sealed.valueAuthTag };
    await VaultSecret.create({ itemId: other.id, field: "password", ...copy });
    await VaultSecret.create({ itemId: own.id, field: "passphrase", ...copy });

    assert.strictEqual(await readSecret(own.id, "password"), "hunter2");
    assert.deepStrictEqual([isUnreadable(own.id), isUnreadable(other.id)], [false, false]);
    for (const [itemId, field] of [[other.id, "password"], [own.id, "passphrase"]]) {
        await assert.rejects(readSecret(itemId, field), (err) =>
            err instanceof VaultError && err.code === VaultErrorCode.ITEM_UNREADABLE && !err.message.includes("hunter2"));
    }
    assert.strictEqual(await readSecret(other.id, "token"), null);
    assert.throws(() => decryptValue({ encrypted: sealed.valueEncrypted, iv: sealed.valueIV, authTag: sealed.valueAuthTag.slice(0, 8) }, `vault:${own.id}:password`));

    assert.deepStrictEqual([isUnreadable(own.id), isUnreadable(other.id)], [true, true]);
    await writeSecret(other.id, "password", "hunter3");
    await clearSecrets(own.id);
    assert.deepStrictEqual([isUnreadable(own.id), isUnreadable(other.id)], [false, false]);
    assert.strictEqual(await readSecret(other.id, "password"), "hunter3");
});

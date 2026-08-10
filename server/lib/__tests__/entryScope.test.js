const test = require("node:test");
const assert = require("node:assert");

// Folder-Model durch ein Fake ersetzen, bevor entry.js es zieht.
const folderPath = require.resolve("../../models/Folder");
const folders = new Map();
require.cache[folderPath] = { id: folderPath, filename: folderPath, loaded: true,
    exports: { findByPk: async (id) => folders.get(id) ?? null } };

const { resolveEntryScope } = require("../../controllers/entry");

test("an entry without a folder keeps its own scope", async () => {
    const scope = await resolveEntryScope({ organizationId: "org-1", accountId: "acc-1" });
    assert.deepStrictEqual(scope, { organizationId: "org-1", ownerAccountId: "acc-1" });
});

test("an entry in a folder inherits the folder scope", async () => {
    folders.set("f-1", { organizationId: "org-folder", accountId: "acc-folder" });
    const scope = await resolveEntryScope({ organizationId: "org-entry", accountId: "acc-entry", folderId: "f-1" });
    assert.deepStrictEqual(scope, { organizationId: "org-folder", ownerAccountId: "acc-folder" },
        "the folder decides, not the entry");
});

test("a missing folder leaves the entry scope untouched", async () => {
    const scope = await resolveEntryScope({ organizationId: "org-entry", accountId: "acc-entry", folderId: "gone" });
    assert.deepStrictEqual(scope, { organizationId: "org-entry", ownerAccountId: "acc-entry" });
});

test("a personal entry reports no organization", async () => {
    const scope = await resolveEntryScope({ organizationId: null, accountId: "acc-1" });
    assert.strictEqual(scope.organizationId, null);
    assert.strictEqual(scope.ownerAccountId, "acc-1");
});

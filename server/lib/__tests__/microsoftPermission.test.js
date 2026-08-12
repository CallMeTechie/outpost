const test = require("node:test");
const assert = require("node:assert");
const { Permission, buildCatalog, getDefaultPermissions } = require("../../permissions/registry");

test("the Microsoft settings permission exists", () => {
    assert.strictEqual(Permission.SETTINGS_MICROSOFT, "settings.microsoft");
});

test("it is a system permission in the settings category", () => {
    const entry = buildCatalog("system").permissions.find(p => p.id === Permission.SETTINGS_MICROSOFT);

    assert.ok(entry, "the permission must appear in the system catalog or nobody can grant it");
    assert.strictEqual(entry.category, "settings");
    assert.ok(entry.label && entry.description, "an ungranted permission with no label is unusable in the UI");
});

// Connecting an outbound OAuth client is an administrative act, not something everyone gets.
test("it is not granted by default", () => {
    assert.ok(!getDefaultPermissions("system").includes(Permission.SETTINGS_MICROSOFT));
});

test("it is not an organization permission", () => {
    assert.ok(!buildCatalog("organization").permissions.some(p => p.id === Permission.SETTINGS_MICROSOFT));
});

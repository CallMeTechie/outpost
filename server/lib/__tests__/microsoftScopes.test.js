const test = require("node:test");
const assert = require("node:assert");
const { buildScopes, hasAllFilesAccess, FILES_SCOPE, FILES_ALL_SCOPE } = require("../microsoft/scopes");

test("offline_access is always requested", () => {
    for (const allFiles of [false, true]) {
        assert.ok(buildScopes(allFiles).split(" ").includes("offline_access"),
            `offline_access missing for allFiles=${allFiles}`);
    }
});

test("the identity scopes are always requested", () => {
    const scopes = buildScopes(false).split(" ");
    for (const scope of ["openid", "email", "profile"]) assert.ok(scopes.includes(scope), `${scope} missing`);
});

test("the checkbox swaps the file scope instead of adding to it", () => {
    const plain = buildScopes(false).split(" ");
    const all = buildScopes(true).split(" ");

    assert.ok(plain.includes(FILES_SCOPE));
    assert.ok(!plain.includes(FILES_ALL_SCOPE));

    assert.ok(all.includes(FILES_ALL_SCOPE));
    assert.ok(!all.includes(FILES_SCOPE),
        "requesting both scopes would ask for consent the checkbox is meant to avoid");
});

test("a missing argument behaves like an unchecked box", () => {
    assert.strictEqual(buildScopes(), buildScopes(false));
});

test("granted scopes are recognised in their short form", () => {
    assert.strictEqual(hasAllFilesAccess("openid profile Files.ReadWrite.All"), true);
    assert.strictEqual(hasAllFilesAccess("openid profile Files.ReadWrite"), false);
});

// Microsoft returns Graph scopes as absolute URIs in some tenants and short names in others.
test("granted scopes are recognised in their absolute form", () => {
    assert.strictEqual(hasAllFilesAccess("https://graph.microsoft.com/Files.ReadWrite.All openid"), true);
    assert.strictEqual(hasAllFilesAccess("https://graph.microsoft.com/Files.ReadWrite openid"), false);
});

test("hasAllFilesAccess survives an empty or absent value", () => {
    for (const value of [null, undefined, "", "   "]) {
        assert.strictEqual(hasAllFilesAccess(value), false, `failed for ${JSON.stringify(value)}`);
    }
});

// Files.ReadWrite is a prefix of Files.ReadWrite.All — a substring check would confuse the two.
test("a plain grant is not mistaken for the wider one", () => {
    assert.strictEqual(hasAllFilesAccess("Files.ReadWrite"), false);
});

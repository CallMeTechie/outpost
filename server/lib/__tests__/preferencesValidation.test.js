const test = require("node:test");
const assert = require("node:assert");
const { preferencesValidation } = require("../../validations/preferences");

const files = (defaultViewMode) => ({ files: { defaultViewMode } });

// Regression for the whole-branch review of feat/file-view-modes: the schema still only knew
// "list" and "grid" after the client gained "details" and "compact", so picking either of those
// two in settings synced fine here but was rejected by the server with a swallowed 400 (Sync
// failed logged to the console, nothing shown to the user), taking the rest of that flush batch
// down with it.
test("defaultViewMode: accepts all four known values", () => {
    for (const mode of ["list", "details", "compact", "grid"]) {
        assert.strictEqual(preferencesValidation.validate(files(mode)).error, undefined, `${mode} should be valid`);
    }
});

test("defaultViewMode: rejects an unknown value", () => {
    assert.ok(preferencesValidation.validate(files("thumbnails")).error, "expected a validation error");
});

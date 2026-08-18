const test = require("node:test");
const assert = require("node:assert");
const { renameDirectives } = require("../../migrations/0043-rename-script-directives");

test("rewrites the input directive prefix", () => {
    assert.strictEqual(renameDirectives('@NEXTERM:STEP "x"'), '@OUTPOST:STEP "x"');
});

test("rewrites result variables referenced in user scripts", () => {
    assert.strictEqual(
        renameDirectives('if [ "$NEXTERM_CONFIRM_RESULT" = "Yes" ]; then'),
        'if [ "$OUTPOST_CONFIRM_RESULT" = "Yes" ]; then');
});

test("leaves unrelated text alone", () => {
    const s = "echo nexterm is not a directive";
    assert.strictEqual(renameDirectives(s), s);
});

test("is reversible", () => {
    const { revertDirectives } = require("../../migrations/0043-rename-script-directives");
    const original = '@NEXTERM:CONFIRM "go" && echo "$NEXTERM_CONFIRM_RESULT"';
    assert.strictEqual(revertDirectives(renameDirectives(original)), original);
});

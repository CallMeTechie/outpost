const test = require("node:test");
const assert = require("node:assert");
const { shouldAudit, AUDIT_ACTIONS } = require("../../controllers/audit");

test("the organization switch turns off exactly the browser actions; without an organization everything is written", () => {
    const browserActions = Object.values(AUDIT_ACTIONS).filter((action) => action.startsWith("browser."));
    assert.ok(browserActions.length > 0);

    const off = { enableBrowserOperationAudit: false, enableAIOperationAudit: true, enableFileOperationAudit: true, enableServerConnectionAudit: true };
    for (const action of browserActions) assert.strictEqual(shouldAudit(action, off), false, action);
    assert.strictEqual(shouldAudit("ai.command", off), true);
    assert.strictEqual(shouldAudit("file.upload", off), true);

    for (const action of browserActions) assert.strictEqual(shouldAudit(action, { ...off, enableBrowserOperationAudit: true }), true, action);
    assert.strictEqual(shouldAudit("browser.click", null), true);
});

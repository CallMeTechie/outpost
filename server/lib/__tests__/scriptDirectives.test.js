const test = require("node:test");
const assert = require("node:assert");
const { transformScript } = require("../../utils/scriptUtils");

// transformScript returns { b64, command }, not the transformed source directly;
// decode the base64 payload before matching against it.
const decode = (content) => Buffer.from(transformScript(content).b64, "base64").toString();

test("transforms the OUTPOST step directive into an echo marker", () => {
    const out = decode('@OUTPOST:STEP "Installing"');
    assert.match(out, /echo "OUTPOST_STEP:Installing"/);
});

test("transforms the OUTPOST confirm directive and reads into the result variable", () => {
    const out = decode('@OUTPOST:CONFIRM "Proceed?"');
    assert.match(out, /OUTPOST_CONFIRM:/);
    assert.match(out, /read -r OUTPOST_CONFIRM_RESULT/);
});

test("leaves the retired NEXTERM prefix untouched", () => {
    const out = decode('@NEXTERM:STEP "Installing"');
    assert.doesNotMatch(out, /echo "OUTPOST_STEP:/);
    assert.doesNotMatch(out, /echo "NEXTERM_STEP:/);
    assert.match(out, /@NEXTERM:STEP/);
});

const { getScriptCommands } = require("../../utils/scriptUtils");
const { ScriptLayer } = require("../ScriptLayer");

test("the ready marker the server emits is the one ScriptLayer waits for", () => {
    const emitted = getScriptCommands("echo hi").join("\n");
    const marker = emitted.match(/echo "([A-Z]+_READY)"/)[1];
    const layer = new ScriptLayer({ write: () => {} }, null, "echo hi", "test-session");
    assert.strictEqual(layer.suppressOutput, true);
    layer.processLine(marker);
    assert.strictEqual(layer.suppressOutput, false,
        "ScriptLayer must release output on the marker scriptUtils actually emits");
});

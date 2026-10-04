const test = require("node:test");
const assert = require("node:assert");
const { transformScript } = require("../../utils/scriptUtils");

test("transformScript: directives in a script with Windows line endings are converted", () => {
    const { b64 } = transformScript("@OUTPOST:STEP \"Install\"\r\n@OUTPOST:INFO \"done\"\r\n");
    const script = Buffer.from(b64, "base64").toString();
    assert.ok(script.includes("echo \"OUTPOST_STEP:Install\""), script);
    assert.ok(script.includes("echo \"OUTPOST_INFO:done\""), script);
    assert.ok(!script.includes("\r"), "carriage returns must not reach bash");
});

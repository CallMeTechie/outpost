const test = require("node:test");
const assert = require("node:assert");
const controlPlane = require("../controlPlane/ControlPlaneServer");
const packageJson = require("../../../package.json");

test("an engine whose version differs from the server is refused before it is registered", async (t) => {
    const sent = [];
    const sendFrame = controlPlane._sendFrame;
    controlPlane._sendFrame = (socket, frame) => sent.push(frame);
    t.after(() => { controlPlane._sendFrame = sendFrame; });

    let destroyed = false;
    const socket = { destroy: () => { destroyed = true; } };
    const envelope = { engineHello: () => ({ version: () => `${packageJson.version}-old`, registrationToken: () => "token" }) };
    const before = controlPlane._engines.size;

    await controlPlane._handleEngineHello(socket, envelope, "10.0.0.9");

    assert.strictEqual(destroyed, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(controlPlane._engines.size, before);
});

const test = require("node:test");
const assert = require("node:assert");
const packageJson = require("../../../package.json");

const enginePath = require.resolve("../../controllers/engine");
let tokenLookups = 0;
require.cache[enginePath] = {
    id: enginePath, filename: enginePath, loaded: true,
    exports: {
        findByToken: async () => { tokenLookups++; return { id: 7, name: "engine" }; },
        updateLastConnected: async () => {},
    },
};
const controlPlane = require("../controlPlane/ControlPlaneServer");

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
    assert.strictEqual(tokenLookups, 0);
    assert.strictEqual(controlPlane._engines.size, before);
});

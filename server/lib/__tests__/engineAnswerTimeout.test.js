const test = require("node:test");
const assert = require("node:assert");
const controlPlane = require("../controlPlane/ControlPlaneServer");

test("a port check waits longer for the engine than the time it gives the engine", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sendFrame = controlPlane._sendFrame;
    controlPlane._sendFrame = () => {};
    controlPlane._engines.set("1", { socket: {}, engineId: "1" });
    t.after(() => {
        controlPlane._sendFrame = sendFrame;
        controlPlane._engines.delete("1");
    });

    let settled = null;
    controlPlane.portCheck([{ id: "1", host: "10.0.0.9", port: 22 }], 30000, "1")
        .then(() => { settled = "resolved"; }, (err) => { settled = err.message; });

    t.mock.timers.tick(30000);
    await Promise.resolve();
    assert.strictEqual(settled, null, "the engine may still answer after using its full 30 s");

    t.mock.timers.tick(5000);
    await Promise.resolve();
    assert.strictEqual(settled, "Request timeout");
});

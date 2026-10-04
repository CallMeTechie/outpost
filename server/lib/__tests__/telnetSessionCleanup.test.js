const test = require("node:test");
const assert = require("node:assert");
const SessionManager = require("../SessionManager");
const controlPlane = require("../controlPlane/ControlPlaneServer");

test("ending a telnet session closes its engine session", async () => {
    const { sessionId } = SessionManager.create("acc", "entry", {});
    const closedIds = [];
    const original = controlPlane.closeSession;
    controlPlane.closeSession = (id) => closedIds.push(id);
    try {
        SessionManager.setConnection(sessionId, { type: "telnet" });
        await SessionManager.remove(sessionId);
    } finally {
        controlPlane.closeSession = original;
    }
    assert.deepStrictEqual(closedIds, [sessionId]);
});

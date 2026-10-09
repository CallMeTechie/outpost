const test = require("node:test");
const assert = require("node:assert");
const { BrowserSession } = require("../BrowserSession");
const { createFakeCdp, createFakeViewer, flush } = require("./helpers/fakeCdp");

const frame = { data: Buffer.from("jpeg").toString("base64"), sessionId: 7, metadata: {} };

const startSession = async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const cdp = createFakeCdp();
    const session = new BrowserSession({ id: "browser-a", accountId: 1, profile: "ephemeral", origin: "agent", cdp, targetId: "T1", cdpSessionId: "S1", bufferLimit: 1000, stallMs: 1000 });
    await session.start();
    return { cdp, session };
};

test("a frame is acknowledged only once the viewer has drained below its limit", async (t) => {
    const { cdp, session } = await startSession(t);
    const viewer = createFakeViewer({ sendCost: 5000 });
    session.addViewer(viewer);
    await flush();

    cdp.emitEvent("Page.screencastFrame", frame, "S1");
    await flush();
    assert.strictEqual(viewer.binary.length, 1);
    t.mock.timers.tick(100);
    await flush();
    assert.strictEqual(cdp.callsOf("Page.screencastFrameAck").length, 0, "still above the limit");

    viewer.bufferedAmount = 0;
    t.mock.timers.tick(16);
    await flush();
    assert.deepStrictEqual(cdp.callsOf("Page.screencastFrameAck").map((c) => c.params), [{ sessionId: 7 }]);
});

test("a hung viewer gets its frames dropped and does not hold the stream for a healthy one", async (t) => {
    const { cdp, session } = await startSession(t);
    const healthy = createFakeViewer();
    const hung = createFakeViewer({ sendCost: 5000 });
    session.addViewer(healthy);
    session.addViewer(hung);
    await flush();

    for (let i = 0; i < 5; i++) {
        cdp.emitEvent("Page.screencastFrame", frame, "S1");
        await flush();
        t.mock.timers.tick(1000);
        await flush();
    }

    assert.strictEqual(healthy.binary.length, 5);
    assert.strictEqual(hung.binary.length, 1, "nothing more is queued for a viewer above its limit");
    assert.strictEqual(hung.bufferedAmount, 5000);
    assert.strictEqual(cdp.callsOf("Page.screencastFrameAck").length, 5);
});

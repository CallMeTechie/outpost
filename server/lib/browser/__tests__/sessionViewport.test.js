const test = require("node:test");
const assert = require("node:assert");
const { BrowserSession } = require("../BrowserSession");
const { createFakeCdp, createFakeViewer, flush } = require("./helpers/fakeCdp");

const startSession = async () => {
    const cdp = createFakeCdp();
    const session = new BrowserSession({ id: "browser-a", accountId: 1, profile: "ephemeral", origin: "agent", cdp, targetId: "T1", cdpSessionId: "S1" });
    await session.start();
    return { cdp, session };
};

const metrics = (cdp) => cdp.callsOf("Emulation.setDeviceMetricsOverride").map((c) => [c.params.width, c.params.height]);

test("an agent session starts at 1280x800 and streams nothing until someone watches", async () => {
    const { cdp, session } = await startSession();
    assert.deepStrictEqual(metrics(cdp), [[1280, 800]]);
    assert.strictEqual(cdp.callsOf("Page.startScreencast").length, 0);

    const viewer = createFakeViewer();
    session.addViewer(viewer);
    await flush();
    assert.deepStrictEqual(cdp.callsOf("Page.startScreencast").map((c) => [c.params.maxWidth, c.params.maxHeight, c.params.quality]), [[1280, 800, 60]]);
    assert.deepStrictEqual(viewer.json[0], { type: "ready", sessionId: "browser-a", url: "about:blank", title: "", viewport: { width: 1280, height: 800 } });

    session.removeViewer(viewer);
    await flush();
    assert.strictEqual(cdp.callsOf("Page.stopScreencast").length, 1);
});

test("only the first viewer's size reaches the page; when it leaves, the next one's stored size applies silently", async () => {
    const { cdp, session } = await startSession();
    const first = createFakeViewer();
    const second = createFakeViewer();
    session.addViewer(first);
    session.addViewer(second);
    await flush();

    await session.handleViewerMessage(first, { type: "resize", width: 1600, height: 900 });
    await session.handleViewerMessage(second, { type: "resize", width: 800, height: 600 });
    assert.deepStrictEqual(metrics(cdp).at(-1), [1600, 900]);
    assert.ok(!metrics(cdp).some(([width]) => width === 800), "the second viewer's size is stored, not applied");

    const messagesBefore = second.json.length;
    session.removeViewer(first);
    await flush();
    assert.deepStrictEqual(metrics(cdp).at(-1), [800, 600]);
    assert.strictEqual(second.json.length, messagesBefore, "the new authority is not told anything");
});

test("viewers, frames and size stay with their own session when a second one is open on the same connection", async () => {
    const cdp = createFakeCdp();
    const make = (id, cdpSessionId) => new BrowserSession({ id, accountId: 1, profile: "ephemeral", origin: "agent", cdp, targetId: `T-${id}`, cdpSessionId });
    const a = make("browser-a", "SA");
    const b = make("browser-b", "SB");
    await a.start();
    await b.start();
    const viewerA = createFakeViewer();
    const viewerB = createFakeViewer();
    a.addViewer(viewerA);
    b.addViewer(viewerB);
    await flush();

    cdp.emitEvent("Page.screencastFrame", { data: Buffer.from("jpeg").toString("base64"), sessionId: 1, metadata: {} }, "SB");
    await flush();
    assert.deepStrictEqual([viewerA.binary.length, viewerB.binary.length], [0, 1]);

    await b.handleViewerMessage(viewerB, { type: "resize", width: 900, height: 700 });
    assert.deepStrictEqual(cdp.callsOf("Emulation.setDeviceMetricsOverride", "SA").map((c) => [c.params.width, c.params.height]), [[1280, 800]]);
    assert.deepStrictEqual([a.viewers.length, b.viewers.length], [1, 1]);
});

test("a screencast that failed to start is retried on the next main-frame navigation", async () => {
    let starts = 0;
    const cdp = createFakeCdp({
        "Page.startScreencast": () => {
            if (++starts === 1) throw new Error("Not attached to an active page");
        },
    });
    const session = new BrowserSession({ id: "browser-a", accountId: 1, profile: "ephemeral", origin: "agent", cdp, targetId: "T1", cdpSessionId: "S1" });
    await session.start();
    const viewer = createFakeViewer();
    session.addViewer(viewer);
    await flush();
    assert.strictEqual(session.screencasting, false);

    cdp.emitEvent("Page.frameNavigated", { frame: { id: "T1", url: "https://a.test/" } }, "S1");
    await flush();
    assert.strictEqual(cdp.callsOf("Page.startScreencast").length, 2);

    cdp.emitEvent("Page.screencastFrame", { data: Buffer.from("jpeg").toString("base64"), sessionId: 1, metadata: {} }, "S1");
    await flush();
    assert.strictEqual(viewer.binary.length, 1);
});

test("settle does not return between the load event and the title that comes with it", async () => {
    let history = { currentIndex: 0, entries: [{ id: 1, url: "https://a.test/", title: "" }] };
    const cdp = createFakeCdp({
        "Page.getNavigationHistory": async () => {
            const answer = history;
            await new Promise((resolve) => setTimeout(resolve, 300));
            return answer;
        },
    });
    const session = new BrowserSession({ id: "browser-a", accountId: 1, profile: "ephemeral", origin: "agent", cdp, targetId: "T1", cdpSessionId: "S1" });
    await session.start();
    history = { currentIndex: 0, entries: [{ id: 1, url: "https://a.test/", title: "Real title" }] };

    cdp.emitEvent("Page.loadEventFired", {}, "S1");
    await session.settle();
    assert.strictEqual(session.state.title, "Real title");
});

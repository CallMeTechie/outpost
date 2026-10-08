const test = require("node:test");
const assert = require("node:assert");
const { BrowserSession } = require("../BrowserSession");
const { BrowserErrorCode } = require("../errors");
const { createFakeCdp, createFakeViewer, flush } = require("./helpers/fakeCdp");

const tree = { nodes: [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "" }, childIds: ["2"] },
    { nodeId: "2", role: { value: "button" }, name: { value: "Go" }, childIds: [], parentId: "1", backendDOMNodeId: 10 },
] };

// Every test runs with a second session already open on the same connection, so state leaking
// between sessions (refs, pause, dialogs) shows up as a failure in B.
const twoSessions = async () => {
    const cdp = createFakeCdp({
        "Accessibility.getFullAXTree": tree,
        "DOM.getContentQuads": { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] },
        "Page.getLayoutMetrics": { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } },
    });
    const make = (id, cdpSessionId, targetId) => new BrowserSession({ id, accountId: 1, profile: "ephemeral", origin: "agent", cdp, targetId, cdpSessionId });
    const a = make("browser-a", "SA", "TA");
    const b = make("browser-b", "SB", "TB");
    await a.start();
    await b.start();
    await a.snapshot();
    await b.snapshot();
    return { cdp, a, b };
};

test("a page navigating on its own invalidates refs of that session only", async () => {
    const { cdp, a, b } = await twoSessions();
    cdp.emitEvent("Page.frameNavigated", { frame: { id: "TA", url: "https://a.test/next" } }, "SA");
    await flush();
    await assert.rejects(a.runAgent("browser_click", () => a.click("e1")), (err) => err.code === BrowserErrorCode.STALE_REF);
    assert.strictEqual(await b.runAgent("browser_click", () => b.click("e1")), 'button "Go"');

    cdp.emitEvent("Page.frameNavigated", { frame: { id: "child", parentId: "TB", url: "https://ads.test/" } }, "SB");
    await flush();
    assert.strictEqual(await b.runAgent("browser_click", () => b.click("e1")), 'button "Go"', "an iframe navigation keeps refs");
});

test("pause refuses agent tools by name while the human keeps operating the page", async () => {
    const { cdp, a, b } = await twoSessions();
    const viewer = createFakeViewer();
    a.addViewer(viewer);
    await a.handleViewerMessage(viewer, { type: "pause", paused: true });

    await assert.rejects(a.runAgent("browser_snapshot", () => a.snapshot()), (err) => err.code === BrowserErrorCode.PAUSED && /paused by the user/.test(err.message));
    await a.handleViewerMessage(viewer, { type: "mouse", action: "down", x: 5, y: 6, button: "left", clickCount: 1, modifiers: 0 });
    assert.deepStrictEqual(cdp.callsOf("Input.dispatchMouseEvent", "SA").at(-1).params, { type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1, modifiers: 0 });
    assert.deepStrictEqual(viewer.json.at(-1), { type: "agent", active: false, tool: null, paused: true });
    assert.strictEqual(typeof await b.runAgent("browser_snapshot", () => b.snapshot()), "string");
});

test("a page dialog goes to the human, interrupts a running agent call, and a stale reply answers nothing", async () => {
    const { cdp, a, b } = await twoSessions();
    const viewer = createFakeViewer();
    a.addViewer(viewer);
    const isDialogPending = (err) => err.code === BrowserErrorCode.DIALOG_PENDING && /Delete everything\?/.test(err.message);
    // The handler is attached before the dialog arrives, or the rejection counts as unhandled.
    const hanging = assert.rejects(a.runAgent("browser_click", () => new Promise(() => {})), isDialogPending);
    cdp.emitEvent("Page.javascriptDialogOpening", { type: "confirm", message: "Delete everything?", url: "https://a.test/items" }, "SA");
    await flush();

    await hanging;
    assert.deepStrictEqual(viewer.json.find((m) => m.type === "dialog"), { type: "dialog", id: 1, kind: "confirm", message: "Delete everything?", defaultPrompt: "", origin: "https://a.test" });
    await assert.rejects(a.runAgent("browser_click", () => a.click("e1")), isDialogPending);
    assert.strictEqual(await b.runAgent("browser_click", () => b.click("e1")), 'button "Go"');

    await a.handleViewerMessage(viewer, { type: "dialogReply", id: 0, accept: true });
    assert.strictEqual(cdp.callsOf("Page.handleJavaScriptDialog", "SA").length, 0, "a reply to an earlier dialog answers nothing");
    await a.handleViewerMessage(viewer, { type: "dialogReply", id: 1, accept: false });
    assert.deepStrictEqual(cdp.callsOf("Page.handleJavaScriptDialog", "SA").map((c) => c.params), [{ accept: false }]);
    cdp.emitEvent("Page.javascriptDialogClosed", { result: false }, "SA");
    await flush();
    assert.deepStrictEqual(viewer.json.at(-1), { type: "dialogClosed" });
    assert.strictEqual(await a.runAgent("browser_click", () => a.click("e1")), 'button "Go"');
});

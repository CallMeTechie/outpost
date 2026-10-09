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
const twoSessions = async (responders = {}) => {
    const cdp = createFakeCdp({
        "Accessibility.getFullAXTree": tree,
        "DOM.getContentQuads": { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] },
        "Page.getLayoutMetrics": { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } },
        ...responders,
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

test("an interrupted agent call drives the page no further, while the human's input still arrives", async () => {
    let releaseInsert;
    const { cdp, a } = await twoSessions({ "Input.insertText": () => new Promise((resolve) => { releaseInsert = resolve; }) });
    const viewer = createFakeViewer();
    a.addViewer(viewer);
    const typing = assert.rejects(a.runAgent("browser_type", () => a.type("e1", "hunter2", { submit: true })),
        (err) => err.code === BrowserErrorCode.DIALOG_PENDING);
    await flush();
    assert.strictEqual(cdp.callsOf("Input.insertText", "SA").length, 1);
    cdp.emitEvent("Page.javascriptDialogOpening", { type: "alert", message: "Saved", url: "https://a.test/" }, "SA");
    await flush();
    await typing;

    const interruptedAt = cdp.calls.length;
    releaseInsert({});
    await flush();
    assert.deepStrictEqual(cdp.calls.slice(interruptedAt).filter((c) => c.sessionId === "SA" && c.method.startsWith("Input.")), [], "no Enter after the interruption");

    await a.handleViewerMessage(viewer, { type: "mouse", action: "down", x: 5, y: 6, button: "left", clickCount: 1, modifiers: 0 });
    assert.deepStrictEqual(cdp.callsOf("Input.dispatchMouseEvent", "SA").at(-1).params, { type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1, modifiers: 0 });
});

test("a second agent call on a busy session is refused instead of interleaving its input", async () => {
    const { cdp, a, b } = await twoSessions();
    let finish;
    const first = a.runAgent("browser_click", () => new Promise((resolve) => { finish = resolve; }));
    await flush();
    await assert.rejects(a.runAgent("browser_type", () => a.type("e1", "x")),
        (err) => err.code === BrowserErrorCode.BUSY && /still running/.test(err.message));
    assert.strictEqual(cdp.callsOf("Input.insertText", "SA").length, 0);
    assert.strictEqual(await b.runAgent("browser_click", () => b.click("e1")), 'button "Go"', "another session is not blocked");

    finish("done");
    assert.strictEqual(await first, "done");
    assert.strictEqual(await a.runAgent("browser_click", () => a.click("e1")), 'button "Go"');
});

test("credentials in the page address reach neither viewers nor the session list", async () => {
    const cdp = createFakeCdp({
        "Page.getNavigationHistory": { currentIndex: 0, entries: [{ id: 1, url: "https://alice:secret@a.test/inbox", title: "Inbox" }] },
    });
    const session = new BrowserSession({ id: "browser-a", accountId: 1, profile: "ephemeral", origin: "agent", cdp, targetId: "TA", cdpSessionId: "SA" });
    await session.start();
    const viewer = createFakeViewer();
    session.addViewer(viewer);

    assert.ok(viewer.json.length > 0);
    assert.ok(viewer.json.every((m) => !JSON.stringify(m).includes("secret")));
    assert.strictEqual(session.summary().url, "https://a.test/inbox");
});

process.env.VAULT_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const { BrowserPool } = require("../BrowserPool");
const { createBrowserTools } = require("../tools");
const vaultGuard = require("../vaultGuard");
const { VaultErrorCode } = require("../../vault/errors");
const { createFakeCdp, flush } = require("./helpers/fakeCdp");

const SECRET = "p@ss word&1";

const textbox = (nodeId, name, backendDOMNodeId, value) => ({
    nodeId, role: { value: "textbox" }, name: { value: name }, childIds: [], parentId: "1", backendDOMNodeId, value: { type: "string", value },
});
const input = (backendNodeId, type) => ({ backendNodeId, localName: "input", nodeName: "INPUT", attributes: ["type", type] });

const setup = () => {
    vaultGuard._resetForTests();
    let targets = 0;
    let contexts = 0;
    const instances = [];
    const page = {
        ax: [
            { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Login" }, childIds: ["2", "3", "4"] },
            textbox("2", "Username", 31, "alice"),
            textbox("3", "Password", 32, "hunter2"),
            textbox("4", "Token", 33, SECRET),
        ],
        dom: [input(31, "text"), input(32, "password"), input(33, "password")],
        history: new Map(),
        evaluate: () => ({ result: { type: "string", value: "ok" } }),
    };
    const launcher = {
        async start({ key }) { return { key, port: 9300 }; },
        async stop() {},
        async endpoint(port) { return `ws://10.0.0.7:${port}/devtools/browser/x`; },
    };
    const connectCdp = async () => {
        const cdp = createFakeCdp({
            "Target.createBrowserContext": () => ({ browserContextId: `ctx-${++contexts}` }),
            "Target.createTarget": () => ({ targetId: `T${++targets}` }),
            "Target.attachToTarget": ({ targetId }) => ({ sessionId: `S-${targetId}` }),
            "Page.getNavigationHistory": (params, sessionId) => ({
                currentIndex: 0, entries: [{ id: 1, ...(page.history.get(sessionId) ?? { url: "https://login.test/", title: "Login" }) }],
            }),
            "Accessibility.getFullAXTree": () => ({ nodes: page.ax }),
            "DOM.getFlattenedDocument": () => ({ nodes: page.dom }),
            "DOM.describeNode": ({ backendNodeId }) => {
                const node = page.dom.find((n) => n.backendNodeId === backendNodeId);
                if (!node) throw new Error("No node with given id found");
                return { node };
            },
            "DOM.getContentQuads": { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] },
            "DOM.resolveNode": ({ backendNodeId }) => ({ object: { objectId: `obj-${backendNodeId}` } }),
            "Page.getLayoutMetrics": { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } },
            "Page.captureScreenshot": { data: "UE5H" },
            "Runtime.evaluate": (params) => page.evaluate(params),
        });
        instances.push(cdp);
        return cdp;
    };
    const pool = new BrowserPool({ getSettings: async () => ({ enabled: true, maxSessions: 10, idleMinutes: 30 }), launcher, connectCdp });
    pool.onContextEnded(vaultGuard.forgetContext);
    const audit = [];
    const tools = createBrowserTools({ getPool: () => pool, audit: async (entry) => { audit.push(entry); }, sleep: async () => {} });
    const agent = (transportId) => ({ accountId: 1, keyId: 41, agent: { keyId: 41, entryId: 7, agentType: "claude" }, transportId, ipAddress: "10.0.0.5", userAgent: "claude-code" });
    const login = (transportId) => ({ accountId: 1, keyId: null, agent: null, transportId, ipAddress: "10.0.0.9", userAgent: "firefox" });
    const text = (result) => result.content.map((c) => c.text ?? "").join("");
    const openSession = async (ctx) => pool.get(/^Session: (\S+)/m.exec(text(await tools.call("browser_open", { url: "https://login.test/" }, ctx)))[1]);
    const openPopup = async (opener, targetId) => {
        instances[0].emitEvent("Target.targetCreated", { targetInfo: { targetId, type: "page", openerId: opener.targetId } });
        await flush();
        return [...pool.sessions.values()].find((record) => record.session.targetId === targetId).session;
    };
    return { pool, tools, page, audit, instances, agent, login, text, openSession, openPopup };
};

test("a password field is masked in the snapshot, the user's own input too; a filled field stays masked and locks screenshots once it shows its value", async () => {
    const { tools, page, audit, instances, agent, text, openSession } = setup();
    const session = await openSession(agent("T"));
    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: SECRET, targetId: session.targetId });

    const shot = await tools.call("browser_screenshot", {}, agent("T"));
    assert.deepStrictEqual(shot.content, [{ type: "image", data: "UE5H", mimeType: "image/png" }], "a filled field that is still a password field is no reason to refuse");

    page.dom = [input(31, "text"), input(32, "password"), input(33, "text")];
    const snapshot = text(await tools.call("browser_snapshot", {}, agent("T")));
    assert.match(snapshot, /- textbox "Username" \[ref=e\d+\] value="alice"/);
    assert.match(snapshot, /- textbox "Password" \[ref=e\d+\] value="••••"/);
    assert.match(snapshot, /- textbox "Token" \[ref=e\d+\] value="••••"/);
    assert.ok(!snapshot.includes("hunter2") && !snapshot.includes("p@ss"));

    const captures = instances[0].callsOf("Page.captureScreenshot").length;
    const refused = await tools.call("browser_screenshot", {}, agent("T"));
    assert.strictEqual(refused.isError, true);
    assert.match(text(refused), /browser_screenshot is locked/);
    assert.strictEqual(instances[0].callsOf("Page.captureScreenshot").length, captures);
    assert.deepStrictEqual(audit.filter((e) => e.action === "vault.screenshot_locked").map((e) => e.details.tool), ["browser_screenshot"]);
});

test("a GET form that put the filled password into the URL leaks it neither to URL:, Title:, browser_list, the open-sessions list nor the audit log, with only the context copy to go by", async () => {
    const { pool, tools, page, audit, instances, agent, login, text, openSession } = setup();
    const filled = await openSession(agent("T"));
    await pool.open({ accountId: 1, url: "https://other.test/", origin: "user" });
    vaultGuard.markFilled(filled.contextKey, { backendNodeIds: [33], secret: SECRET, targetId: filled.targetId });

    page.history.set(filled.cdpSessionId, {
        url: "https://login.test/done?user=alice&pw=p%40ss+word%261&echo=p%40ss%20word%261",
        title: `Welcome ${SECRET}`,
    });
    instances[0].emitEvent("Page.frameNavigated", { frame: { id: filled.targetId, url: "https://login.test/done" } }, filled.cdpSessionId);
    await flush();
    page.evaluate = () => ({ result: { type: "string", value: `Welcome ${SECRET}\nSigned in` } });

    const snapshot = text(await tools.call("browser_snapshot", {}, agent("T")));
    const outputs = [
        snapshot,
        text(await tools.call("browser_click", { ref: /Username" \[ref=(e\d+)\]/.exec(snapshot)[1] }, agent("T"))),
        text(await tools.call("browser_list", {}, agent("T"))),
        text(await tools.call("browser_snapshot", { sessionId: "browser-unknown" }, login("L"))),
        text(await tools.call("browser_wait", { condition: "text", value: "Signed in", timeoutMs: 1 }, agent("T"))),
    ];
    assert.match(outputs[0], /^URL: https:\/\/login\.test\/done\?user=alice&pw=••••&echo=••••$/m);
    assert.match(outputs[0], /^Title: Welcome ••••$/m);
    assert.match(outputs[3], /Open sessions:[\s\S]*pw=••••/);
    assert.match(outputs[4], /^Title: Welcome ••••$/m, "browser_wait finds visible text");
    const probe = await tools.call("browser_wait", { condition: "text", value: "ss wo", timeoutMs: 1 }, agent("T"));
    assert.strictEqual(probe.isError, true);
    assert.strictEqual(text(probe), 'Condition text "ss wo" not met within 1 ms', "a part of the filled value is not on the page for browser_wait");
    for (const leaked of ["p@ss", "%40ss", "word&1", "word%261"]) {
        assert.ok(outputs.every((output) => !output.includes(leaked)), `${leaked} reached the agent`);
        assert.ok(!JSON.stringify(audit).includes(leaked), `${leaked} reached the audit log`);
    }
    assert.ok(audit.some((e) => e.action === "browser.click" && e.details.url.includes("pw=••••")));
});

test("after a fill, browser_evaluate is refused in every session of the context, a popup included, before anything reaches the page", async () => {
    const { tools, page, audit, instances, agent, text, openSession, openPopup } = setup();
    const opener = await openSession(agent("T"));
    const popup = await openPopup(opener, "POP");
    vaultGuard.markFilled(opener.contextKey, { backendNodeIds: [33], secret: SECRET, targetId: opener.targetId });
    let sent = 0;
    page.evaluate = () => {
        sent++;
        return { result: { type: "string", value: "ok" } };
    };

    const refused = await tools.call("browser_evaluate", { sessionId: popup.id, expression: "document.querySelector('input').value" }, agent("T"));
    assert.strictEqual(refused.isError, true);
    assert.match(text(refused), /browser_evaluate is locked/);
    assert.strictEqual(sent, 0);
    assert.strictEqual(instances[0].callsOf("Runtime.evaluate", popup.cdpSessionId).length, 0);
    assert.deepStrictEqual(audit.filter((e) => e.action === "vault.evaluate_locked").map((e) => e.details.sessionId), [popup.id]);
});

test("browser_evaluate marks its context before the expression is sent, also when the expression then fails, and a later fill there is refused", async () => {
    const { tools, page, agent, openSession, openPopup } = setup();
    const opener = await openSession(agent("T"));
    const popup = await openPopup(opener, "POP");
    const other = await openSession(agent("U"));
    const taintedWhenSent = [];
    page.evaluate = () => {
        taintedWhenSent.push(vaultGuard.isTainted(opener.contextKey));
        return { exceptionDetails: { text: "Uncaught TypeError" } };
    };

    const failed = await tools.call("browser_evaluate", { sessionId: popup.id, expression: "window.opener.x()" }, agent("T"));
    assert.strictEqual(failed.isError, true);
    assert.deepStrictEqual(taintedWhenSent, [true]);
    assert.throws(() => vaultGuard.markFilled(opener.contextKey, { backendNodeIds: [33], secret: SECRET, targetId: opener.targetId }),
        (err) => err.code === VaultErrorCode.SESSION_TAINTED);
    assert.strictEqual(vaultGuard.isTainted(other.contextKey), false, "another context stays clean");
});

test("the guard forgets a context when it ends: an ephemeral one with its opener, a persistent one with its last session", async () => {
    const { pool, agent, openSession, openPopup } = setup();
    const opener = await openSession(agent("T"));
    const first = await openPopup(opener, "POP1");
    const second = await openPopup(opener, "POP2");
    vaultGuard.markFilled(opener.contextKey, { backendNodeIds: [33], secret: SECRET, targetId: opener.targetId });
    vaultGuard.markTainted(opener.contextKey);

    await pool.close(first.id, "test");
    await flush();
    assert.deepStrictEqual([vaultGuard.isFilled(opener.contextKey), vaultGuard.isTainted(opener.contextKey)], [true, true], "a popup closing ends nothing");

    await pool.close(opener.id, "test");
    await flush();
    assert.strictEqual(pool.get(second.id), null, "the popups end with the context");
    assert.deepStrictEqual([vaultGuard.isFilled(opener.contextKey), vaultGuard.isTainted(opener.contextKey)], [false, false]);
    assert.strictEqual(vaultGuard.redactText(opener.contextKey, SECRET), SECRET);

    const { session: p1 } = await pool.open({ accountId: 1, url: "https://a.test/", profile: "persistent" });
    const { session: p2 } = await pool.open({ accountId: 1, url: "https://b.test/", profile: "persistent" });
    vaultGuard.markTainted(p1.contextKey);
    await pool.close(p1.id, "test");
    await flush();
    assert.strictEqual(vaultGuard.isTainted(p2.contextKey), true);
    await pool.close(p2.id, "test");
    await flush();
    assert.strictEqual(vaultGuard.isTainted(p2.contextKey), false);
});

test("selecting text is locked once the context is filled and middle-click paste always; Shift+Tab, a plain click and browser_type without selection go on", async () => {
    const { tools, audit, instances, agent, text, openSession } = setup();
    const session = await openSession(agent("T"));
    const ref = /Username" \[ref=(e\d+)\]/.exec(text(await tools.call("browser_snapshot", {}, agent("T"))))[1];
    const locked = /^Selecting text and middle-click paste are locked in this session/;

    const early = await tools.call("browser_click", { ref, button: "middle" }, agent("T"));
    assert.strictEqual(early.isError, true);
    assert.match(text(early), locked, "middle-click pastes the selection another context may hold");
    assert.match(text(early), /\(vault\.input_locked\)$/, "the agent gets the code with the message");
    assert.ok(!(await tools.call("browser_key", { key: "Control+a" }, agent("T"))).isError, "before a fill, select-all is fine");
    assert.ok(!(await tools.call("browser_click", { ref, clickCount: 2 }, agent("T"))).isError);
    const callsDuring = async (call) => {
        const from = instances[0].calls.length;
        assert.ok(!(await call()).isError);
        return instances[0].calls.slice(from);
    };
    const selectsAll = (calls) => calls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.commands?.includes("selectAll"));
    assert.ok(selectsAll(await callsDuring(() => tools.call("browser_type", { ref, text: "bob" }, agent("T")))), "before a fill, browser_type selects as before");

    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: SECRET, targetId: session.targetId });
    const input = () => instances[0].calls.filter((c) => c.method.startsWith("Input.")).length;
    const before = input();
    for (const [tool, args] of [
        ["browser_key", { key: "Control+a" }],
        ["browser_key", { key: "Shift+ArrowLeft" }],
        ["browser_click", { ref, clickCount: 2 }],
        ["browser_click", { ref, button: "middle" }],
    ]) {
        const refused = await tools.call(tool, args, agent("T"));
        assert.strictEqual(refused.isError, true, `${tool} ${JSON.stringify(args)}`);
        assert.match(text(refused), locked);
    }
    assert.strictEqual(input(), before, "no input event reached the page");
    const typing = await callsDuring(() => tools.call("browser_type", { ref, text: "carol" }, agent("T")));
    assert.ok(!selectsAll(typing), "in a filled context browser_type clears without selecting");
    assert.deepStrictEqual(typing.filter((c) => c.method === "Runtime.callFunctionOn").map((c) => [c.params.objectId, c.params.functionDeclaration]),
        [["obj-31", "function () { if (this.isContentEditable && !('value' in this)) this.textContent = ''; else this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }"]]);
    assert.deepStrictEqual(typing.filter((c) => c.method === "Input.insertText").map((c) => c.params.text), ["carol"]);
    assert.ok(!(await tools.call("browser_key", { key: "Shift+Tab" }, agent("T"))).isError);
    assert.ok(!(await tools.call("browser_click", { ref }, agent("T"))).isError);
    assert.deepStrictEqual(audit.filter((e) => e.action === "vault.input_locked").map((e) => e.details.tool),
        ["browser_click", "browser_key", "browser_key", "browser_click", "browser_click"]);
});

test("secrets with quotes, backslashes, a clip boundary or a shorter sibling are redacted in snapshot, label and audit", async () => {
    const { tools, page, audit, agent, text, openSession } = setup();
    const session = await openSession(agent("T"));
    const quoted = 'Tr0ub"le\\x9';
    const long = `${"x".repeat(97)}${quoted}tail`;
    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: "abc", targetId: session.targetId });
    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: "abcdef", targetId: session.targetId });
    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: quoted, targetId: session.targetId });
    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: long, targetId: session.targetId });
    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: 'p" q', targetId: session.targetId });
    page.ax = [
        { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Login" }, childIds: ["2", "5"] },
        { nodeId: "2", role: { value: "heading" }, name: { value: `Hi ${quoted} abcdef x p"\n q y` }, childIds: [], parentId: "1" },
        { ...textbox("5", `${"y".repeat(96)}${quoted}`, 34, "v"), parentId: "1" },
    ];
    page.dom = [input(34, "text")];

    const snapshot = text(await tools.call("browser_snapshot", {}, agent("T")));
    const ref = /\[ref=(e\d+)\]/.exec(snapshot)[1];
    const clicked = text(await tools.call("browser_click", { ref }, agent("T")));
    assert.match(snapshot, /- heading "Hi •••• •••• x •••• y"/);
    for (const leaked of ["Tr0ub", "p\\\" q", "q y", "le\\\\x9", "x9", "def", "xxxxxxx", "yyyyyy".repeat(2) + "Tr"]) {
        assert.ok(!snapshot.includes(leaked) && !clicked.includes(leaked), `${leaked} reached the agent`);
        assert.ok(!JSON.stringify(audit).includes(leaked), `${leaked} reached the audit log`);
    }
});

test("a filled node that vanished (Show password swaps the input) keeps screenshots locked until the main frame navigates; the filled node coming back shown locks again", async () => {
    const { tools, page, instances, agent, text, openSession, openPopup } = setup();
    const session = await openSession(agent("T"));
    const popup = await openPopup(session, "POP");
    vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: SECRET, targetId: session.targetId });
    page.dom = [input(31, "text"), input(32, "password"), input(34, "text")];

    const refused = await tools.call("browser_screenshot", {}, agent("T"));
    assert.strictEqual(refused.isError, true);
    assert.match(text(refused), /browser_screenshot is locked/);

    instances[0].emitEvent("Page.frameNavigated", { frame: { id: popup.targetId, url: "https://login.test/popup" } }, popup.cdpSessionId);
    await flush();
    assert.throws(() => vaultGuard.markFilled(session.contextKey, { backendNodeIds: [33], secret: SECRET }), TypeError);
    assert.strictEqual((await tools.call("browser_screenshot", {}, agent("T"))).isError, true, "another session navigating unlocks nothing");

    instances[0].emitEvent("Page.frameNavigated", { frame: { id: session.targetId, url: "https://login.test/next" } }, session.cdpSessionId);
    await flush();
    assert.strictEqual((await tools.call("browser_screenshot", {}, agent("T"))).isError, undefined);

    page.dom = [input(31, "text"), input(33, "text")];
    instances[0].emitEvent("Page.frameNavigated", { frame: { id: session.targetId, url: "https://login.test/" } }, session.cdpSessionId);
    await flush();
    assert.strictEqual((await tools.call("browser_screenshot", {}, agent("T"))).isError, true, "back from the bfcache the shown field is still the filled node");
});

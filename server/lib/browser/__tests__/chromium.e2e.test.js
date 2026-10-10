const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { BrowserPool } = require("../BrowserPool");
const { createLauncherClient } = require("../launcher");
const { BrowserErrorCode } = require("../errors");
const { clickablePoint, click: rawClick } = require("../actions");
const { createFakeViewer, flush } = require("./helpers/fakeCdp");

const LAUNCHER = process.env.OUTPOST_BROWSER_E2E_LAUNCHER;
const PAGE_HOST = process.env.OUTPOST_BROWSER_E2E_PAGE_HOST;

const START = `<!doctype html><title>E2E start</title>
<h1>Start</h1>
<input aria-label="Name">
<button onclick="document.querySelector('h1').textContent = 'Hello ' + document.querySelector('input').value">Greet</button>
<select aria-label="Country"><option>France</option><option selected>Germany</option><option>Italy</option></select>
<a href="/second">Next page</a>`;
const SECOND = "<!doctype html><title>E2E second</title><h1>Second</h1>";

const refOf = (snapshot, label) => new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SECRET = "pa ss&wörd+1";
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LOGIN_PAGE = `<!doctype html><title>Vault login</title>
<h1>Sign in</h1>
<form method="get" action="/done">
<input name="user" aria-label="User">
<input name="pass" id="pass" type="password" aria-label="Password">
<button type="button" onclick="const f = document.getElementById('pass'); f.type = f.type === 'password' ? 'text' : 'password'">Show password</button>
<button type="submit">Sign in</button>
</form>
<button type="button" onclick="window.open('/popup', 'vault-popup', 'width=400,height=300')">Open popup</button>`;
const POPUP_PAGE = "<!doctype html><title>Vault popup</title><h1>Popup</h1>";
const FRAME_FIELD = `<!doctype html><title>Frame field</title>
<input name="pass" type="password" aria-label="Frame password">`;
const framePage = (src) => `<!doctype html><title>Frame host</title>
<h1>Frame host</h1>
<iframe src="${src}" width="600" height="320"></iframe>`;
const donePage = (url) => `<!doctype html><title>Signed in ${escapeHtml(new URL(url, "http://page.invalid").searchParams.get("pass") ?? "")}</title>
<h1>Signed in</h1>
<a href="/login">Back</a>`;

const startVaultPages = async (t) => {
    const bases = {};
    const serve = (other) => http.createServer((req, res) => {
        const pages = {
            "/login": () => LOGIN_PAGE,
            "/popup": () => POPUP_PAGE,
            "/frame": () => FRAME_FIELD,
            "/done": () => donePage(req.url),
            "/framed-self": () => framePage("/login"),
            "/frame-other": () => framePage(`${bases[other]}/frame`),
            "/embed-other": () => framePage(`${bases[other]}/login`),
        };
        const page = pages[req.url.split("?")[0]];
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(page ? page() : "<!doctype html><title>Not found</title>");
    });
    for (const [name, server] of [["a", serve("b")], ["b", serve("a")]]) {
        await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
        t.after(() => server.close());
        bases[name] = `http://${PAGE_HOST}:${server.address().port}`;
    }
    return bases;
};

const startVaultBed = async (t) => {
    process.env.VAULT_KEY ??= "5a".repeat(32);
    const vaultBed = require("../../vault/__tests__/helpers/vaultBed");
    const { createVaultProvider } = require("../../vault/mcpProvider");
    const { createBrowserTools } = require("../tools");
    const { Permission } = require("../../../permissions/registry");
    const bases = await startVaultPages(t);
    const pool = new BrowserPool({
        getSettings: async () => ({ enabled: true, maxSessions: 8, idleMinutes: 30, callbackHost: PAGE_HOST }),
        launcher: createLauncherClient(async () => LAUNCHER),
        // A via instance without a tunnel: enough for the refusal, which never reaches the network.
        createVia: async () => ({ label: "nas", organizationId: null, resolverRule: null, close() {} }),
    });
    t.after(() => {
        for (const instance of pool.live.values()) instance.cdp.close();
    });
    const audit = [];
    const record = async (entry) => { audit.push(entry); };
    const browserTools = createBrowserTools({ getPool: () => pool, audit: record });
    const vault = createVaultProvider({
        getBrowserTools: () => browserTools, audit: record,
        approvals: { requestApproval: async () => "once", forgetTransport() {} },
    });
    vaultBed.reset({
        items: [{
            id: 41, accountId: 1, organizationId: null, name: "e2e-login", type: "login", description: null,
            fields: { username: "ada", origins: [bases.a] }, approvalRequired: false, allServers: true,
        }],
        secrets: { "41:password": SECRET },
        permissions: [Permission.VAULT_USE, Permission.CONNECT_BROWSER],
    });
    const ctx = { accountId: 1, keyId: null, agent: null, impersonatorId: null, transportId: "e2e", ipAddress: "127.0.0.1", userAgent: "e2e", signal: new AbortController().signal };
    const call = (provider, name, args) => provider.call(name, args, ctx);
    const open = async (url, options = {}) => {
        const { session } = await pool.open({ accountId: 1, url, ...options });
        await session.settle();
        return session;
    };
    return {
        bases, pool, audit, browserTools, call, open, vaultBed,
        text: (result) => result.content.map((c) => c.text ?? "").join(""),
        snapshotOf: (session) => session.runAgent("browser_snapshot", () => session.snapshot()),
        fill: (session, args) => call(vault, "browser_fill_credential", { item: "e2e-login", sessionId: session.id, ...args }),
    };
};

// Raw CDP: reads the page past the evaluate lock, which only guards the agent's tools.
const valueIn = async (session, expression) => (await session.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

const until = async (probe, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
        const value = await probe();
        if (value) return value;
    }
    throw new Error("timed out");
};

const attributeOf = (node, name) => {
    const list = node.attributes ?? [];
    for (let i = 0; i < list.length; i += 2) if (list[i] === name) return list[i + 1];
    return null;
};

// The snapshot covers the main frame only; a ref into a frame is taken from the DOM, as a page could
// hand one out once frames are part of the snapshot.
const refInDocument = async (session, documentUrl, name) => {
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const stack = [[root, root.documentURL]];
    while (stack.length > 0) {
        const [node, url] = stack.pop();
        const here = node.nodeName === "#document" ? node.documentURL : url;
        if (node.nodeName === "INPUT" && here === documentUrl && attributeOf(node, "name") === name)
            return session.refs.assign(node.backendNodeId, `textbox "${name}"`);
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])])
            stack.push([child, here]);
    }
    throw new Error(`no input ${name} in ${documentUrl}; the frame may run out of process`);
};

const openPopup = async ({ pool, browserTools, call }, opener, buttonRef) => {
    const before = new Set(pool.listForAccount(1).map((s) => s.id));
    await call(browserTools, "browser_click", { sessionId: opener.id, ref: buttonRef });
    return until(() => pool.listForAccount(1).map((s) => s.id).find((id) => !before.has(id)));
};

const refused = (text, result, code) => {
    assert.strictEqual(result.isError, true, `expected ${code}, got: ${text(result)}`);
    assert.ok(text(result).includes(code), text(result));
};

test("against a real Chromium: snapshot, type, click, frames, navigation, close, persistent login",
    { skip: !LAUNCHER && "set OUTPOST_BROWSER_E2E_LAUNCHER and OUTPOST_BROWSER_E2E_PAGE_HOST" }, async (t) => {
        const server = http.createServer((req, res) => {
            if (req.url === "/set-cookie") res.setHeader("set-cookie", "login=ada; Max-Age=3600; Path=/");
            res.setHeader("content-type", "text/html");
            res.end(req.url === "/second" ? SECOND : START);
        });
        await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
        t.after(() => server.close());
        const base = `http://${PAGE_HOST}:${server.address().port}`;

        const pool = new BrowserPool({
            getSettings: async () => ({ enabled: true, maxSessions: 4, idleMinutes: 30, callbackHost: PAGE_HOST }),
            launcher: createLauncherClient(async () => LAUNCHER),
            createVia: async () => { throw new Error("via is part of the manual acceptance"); },
        });
        t.after(() => {
            for (const instance of pool.live.values()) instance.cdp.close();
        });

        const { session, navigationError } = await pool.open({ accountId: 1, url: `${base}/` });
        assert.strictEqual(navigationError, null);
        const viewer = createFakeViewer();
        session.addViewer(viewer);
        await session.settle();

        let snapshot = await session.runAgent("browser_snapshot", () => session.snapshot());
        assert.match(snapshot, /- heading "Start" level=1/);
        await session.runAgent("browser_type", () => session.type(refOf(snapshot, 'textbox "Name"'), "Ada"));
        await session.runAgent("browser_click", () => session.click(refOf(snapshot, 'button "Greet"')));
        await session.settle();
        snapshot = await session.snapshot();
        assert.match(snapshot, /- heading "Hello Ada" level=1/);

        const tap = async ({ x, y }) => {
            await session.handleViewerMessage(viewer, { type: "mouse", action: "down", x, y, button: "left", clickCount: 1 });
            await session.handleViewerMessage(viewer, { type: "mouse", action: "up", x, y, button: "left", clickCount: 1, focusCheck: true });
            return viewer.json.at(-1);
        };
        const field = await clickablePoint(session.send, session.refs.resolve(refOf(snapshot, 'textbox "Name"')).backendNodeId);
        assert.deepStrictEqual(await tap(field), { type: "focus", editable: true });
        assert.deepStrictEqual(await tap({ x: 600, y: 700 }), { type: "focus", editable: false }, "a tap on empty page space");

        await session.runAgent("browser_type", () => session.type(refOf(snapshot, 'combobox "Country"'), "Italy"));
        snapshot = await session.snapshot();
        assert.match(snapshot, /- combobox "Country" \[ref=e\d+\] value="Italy"/);
        assert.match(snapshot, / {2}- option "Italy" selected/);

        await sleep(500);
        assert.ok(viewer.binary.length > 0, "the viewer received frames");
        const frame = viewer.binary.at(-1);
        assert.deepStrictEqual([frame[0], frame[5], frame[6]], [0x01, 0xff, 0xd8], "opcode, then a JPEG");

        const link = refOf(snapshot, 'link "Next page"');
        await session.runAgent("browser_click", () => session.click(link));
        await session.settle();
        await assert.rejects(session.click(link), (err) => err.code === BrowserErrorCode.STALE_REF);
        assert.strictEqual(session.state.title, "E2E second");

        for (const url of ["http://127.0.0.1:10222/json/list", "http://[::ffff:127.0.0.1]:10222/json/list", "http://localhost.:10222/json/list"])
            await assert.rejects(session.navigate(url),
                (err) => err.code === BrowserErrorCode.NAVIGATION_FAILED && /ERR_BLOCKED_BY_ADMINISTRATOR/.test(err.message),
                `a page must not reach the container's own DevTools: ${url}`);

        await pool.close(session.id, "test");
        await flush();
        assert.deepStrictEqual(viewer.json.at(-1), { type: "closed", reason: "test" });

        const first = await pool.open({ accountId: 1, url: `${base}/set-cookie`, profile: "persistent" });
        await first.session.settle();
        await pool.close(first.session.id, "test");
        // Otherwise the next open reuses the running instance and proves nothing about the profile on disk.
        while (pool.instances.has("account-1") || pool.retiring.has("account-1")) await sleep(50);
        const again = await pool.open({ accountId: 1, url: `${base}/`, profile: "persistent" });
        assert.notStrictEqual(again.session.cdp, first.session.cdp, "a new instance was started");
        await again.session.settle();
        assert.strictEqual(await again.session.evaluate("document.cookie"), "login=ada");
        await pool.close(again.session.id, "test");
    });

test("against a real Chromium: a filled field stays masked after Show password, and screenshot and evaluate lock",
    { skip: !LAUNCHER && "set OUTPOST_BROWSER_E2E_LAUNCHER and OUTPOST_BROWSER_E2E_PAGE_HOST" }, async (t) => {
        process.env.VAULT_KEY ??= "5a".repeat(32);
        const vaultGuard = require("../vaultGuard");
        const value = "guard pa55&word";
        const page = `<!doctype html><title>Guard</title>
<input id="pass" type="password" aria-label="Password">
<button type="button" onclick="const f = document.getElementById('pass'); f.type = f.type === 'password' ? 'text' : 'password'">Show password</button>`;
        const server = http.createServer((req, res) => {
            res.setHeader("content-type", "text/html");
            res.end(page);
        });
        await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
        t.after(() => server.close());
        const pool = new BrowserPool({
            getSettings: async () => ({ enabled: true, maxSessions: 4, idleMinutes: 30, callbackHost: PAGE_HOST }),
            launcher: createLauncherClient(async () => LAUNCHER),
            createVia: async () => { throw new Error("via is part of the manual acceptance"); },
        });
        t.after(() => {
            for (const instance of pool.live.values()) instance.cdp.close();
        });
        const audit = [];
        const tools = require("../tools").createBrowserTools({ getPool: () => pool, audit: async (entry) => { audit.push(entry); } });
        const ctx = { accountId: 1, keyId: null, agent: null, transportId: "E2E-GUARD", ipAddress: "127.0.0.1", userAgent: "e2e" };
        const text = (result) => result.content.map((c) => c.text ?? "").join("");

        const opened = text(await tools.call("browser_open", { url: `http://${PAGE_HOST}:${server.address().port}/` }, ctx));
        const session = pool.get(/^Session: (\S+)/m.exec(opened)[1]);
        const typed = text(await tools.call("browser_type", { ref: refOf(opened, 'textbox "Password"'), text: value }, ctx));
        assert.ok(!typed.includes("pa55"), "the typed password does not reach the snapshot");
        vaultGuard.markFilled(session.contextKey, { backendNodeIds: [session.refs.resolve(refOf(typed, 'textbox "Password"')).backendNodeId], secret: value, targetId: session.targetId });
        assert.strictEqual((await tools.call("browser_screenshot", {}, ctx)).content[0].type, "image", "the filled field is still a password field");

        const shown = text(await tools.call("browser_click", { ref: refOf(typed, 'button "Show password"') }, ctx));
        assert.match(shown, /- textbox "Password" \[ref=e\d+\] value="••••"/);
        assert.ok(!shown.includes("pa55"), "the value in plain text does not reach the snapshot");
        const shot = await tools.call("browser_screenshot", {}, ctx);
        assert.strictEqual(shot.isError, true);
        assert.match(text(shot), /browser_screenshot is locked/);
        const evaluated = await tools.call("browser_evaluate", { expression: "document.getElementById('pass').value" }, ctx);
        assert.strictEqual(evaluated.isError, true);
        assert.match(text(evaluated), /browser_evaluate is locked/);
        assert.deepStrictEqual(audit.filter((e) => e.action.startsWith("vault.")).map((e) => e.action), ["vault.screenshot_locked", "vault.evaluate_locked"]);
        assert.ok(!JSON.stringify(audit).includes("pa55"));
        await pool.close(session.id, "test");
    });

test("against a real Chromium: browser_fill_credential fills a matching origin and refuses foreign origins and frames, via, persistent and tainted contexts",
    { skip: !LAUNCHER && "set OUTPOST_BROWSER_E2E_LAUNCHER and OUTPOST_BROWSER_E2E_PAGE_HOST" }, async (t) => {
        // The persistent instance of account 1 outlives the earlier tests and keeps their taint, which
        // would answer the persistent case below with vault.session_tainted (check 3a precedes 3b).
        require("../vaultGuard")._resetForTests();
        const bed = await startVaultBed(t);
        const { bases, pool, browserTools, call, open, text, snapshotOf, fill } = bed;
        const PASS = "document.getElementById('pass').value";

        const own = await open(`${bases.a}/login`);
        let snapshot = await snapshotOf(own);
        const filled = await fill(own, { usernameRef: refOf(snapshot, 'textbox "User"'), passwordRef: refOf(snapshot, 'textbox "Password"') });
        assert.strictEqual(text(filled), "Filled username and password of e2e-login.");
        assert.deepStrictEqual([await valueIn(own, "document.querySelector('[name=user]').value"), await valueIn(own, PASS)], ["ada", SECRET]);
        await pool.close(own.id, "test");

        const framed = await open(`${bases.a}/framed-self`);
        const inFrame = await fill(framed, { passwordRef: await refInDocument(framed, `${bases.a}/login`, "pass") });
        assert.strictEqual(text(inFrame), "Filled password of e2e-login.", "the focus check follows the focus into a frame of the same origin");
        assert.strictEqual(await valueIn(framed, "document.querySelector('iframe').contentDocument.getElementById('pass').value"), SECRET);
        await pool.close(framed.id, "test");

        const foreign = await open(`${bases.b}/login`);
        snapshot = await snapshotOf(foreign);
        refused(text, await fill(foreign, { passwordRef: refOf(snapshot, 'textbox "Password"') }), "vault.origin_mismatch");
        assert.strictEqual(await valueIn(foreign, PASS), "");
        await pool.close(foreign.id, "test");

        const foreignFrame = await open(`${bases.a}/frame-other`);
        refused(text, await fill(foreignFrame, { passwordRef: await refInDocument(foreignFrame, `${bases.b}/frame`, "pass") }), "vault.origin_mismatch");
        await pool.close(foreignFrame.id, "test");

        const embedded = await open(`${bases.b}/embed-other`);
        refused(text, await fill(embedded, { passwordRef: await refInDocument(embedded, `${bases.a}/login`, "pass") }), "vault.origin_mismatch");
        assert.strictEqual(await valueIn(embedded, "document.querySelector('iframe') !== null"), true);
        await pool.close(embedded.id, "test");

        const wrongField = await open(`${bases.a}/login`);
        snapshot = await snapshotOf(wrongField);
        refused(text, await fill(wrongField, { passwordRef: refOf(snapshot, 'textbox "User"') }), "vault.not_password_field");
        assert.strictEqual(await valueIn(wrongField, "document.querySelector('[name=user]').value"), "");
        await pool.close(wrongField.id, "test");

        for (const [options, code] of [[{ via: "nas" }, "vault.via_not_allowed"], [{ profile: "persistent" }, "vault.persistent_not_allowed"]]) {
            const session = await open(`${bases.a}/login`, options);
            snapshot = await snapshotOf(session);
            refused(text, await fill(session, { passwordRef: refOf(snapshot, 'textbox "Password"') }), code);
            assert.strictEqual(await valueIn(session, PASS), "");
            await pool.close(session.id, "test");
        }

        const opener = await open(`${bases.a}/login`);
        snapshot = await snapshotOf(opener);
        const popupId = await openPopup(bed, opener, refOf(snapshot, 'button "Open popup"'));
        assert.ok(!(await call(browserTools, "browser_evaluate", { sessionId: popupId, expression: "document.title" })).isError);
        await call(browserTools, "browser_close", { sessionId: popupId });
        refused(text, await fill(opener, { passwordRef: refOf(snapshot, 'textbox "Password"') }), "vault.session_tainted");
        assert.strictEqual(await valueIn(opener, PASS), "");
        await pool.close(opener.id, "test");
    });

test("against a real Chromium: after a fill the password stays out of evaluate, snapshots, screenshots, URL, Title, browser_list, audit and the selection",
    { skip: !LAUNCHER && "set OUTPOST_BROWSER_E2E_LAUNCHER and OUTPOST_BROWSER_E2E_PAGE_HOST" }, async (t) => {
        const bed = await startVaultBed(t);
        const { bases, pool, audit, browserTools, call, open, text, snapshotOf, fill, vaultBed } = bed;
        const session = await open(`${bases.a}/login`);
        const snapshot = await snapshotOf(session);
        const ref = (label) => refOf(snapshot, label);
        const tool = (name, args = {}) => call(browserTools, name, { sessionId: session.id, ...args });

        const filled = await fill(session, { usernameRef: ref('textbox "User"'), passwordRef: ref('textbox "Password"') });
        assert.ok(!filled.isError, text(filled));

        refused(text, await tool("browser_key", { key: "Control+a" }), "vault.input_locked");
        refused(text, await tool("browser_click", { ref: ref('textbox "Password"'), clickCount: 3 }), "vault.input_locked");
        const again = await fill(session, { usernameRef: ref('textbox "User"'), passwordRef: ref('textbox "Password"') });
        assert.ok(!again.isError, text(again));
        assert.deepStrictEqual([await valueIn(session, "document.querySelector('[name=user]').value"), await valueIn(session, "document.getElementById('pass').value")],
            ["ada", SECRET], "a second fill clears the fields instead of selecting their content");
        const elsewhere = await open(`${bases.b}/login`);
        const otherUser = refOf(await snapshotOf(elsewhere), 'textbox "User"');
        refused(text, await call(browserTools, "browser_click", { sessionId: elsewhere.id, ref: otherUser, button: "middle" }), "vault.input_locked");
        // Past the guard, as the user's own middle click would: the shared primary selection must not hold the password.
        await rawClick(elsewhere.send, elsewhere.refs.resolve(otherUser).backendNodeId, { button: "middle" });
        assert.ok(!(await valueIn(elsewhere, "document.querySelector('[name=user]').value")).includes(SECRET), "a middle click in another context pastes no password");
        const probe = await open(`${bases.b}/login`);
        const probeUser = refOf(await snapshotOf(probe), 'textbox "User"');
        await valueIn(probe, "document.querySelector('[name=user]').value = 'primary-probe'");
        await rawClick(probe.send, probe.refs.resolve(probeUser).backendNodeId, { clickCount: 3 });
        await rawClick(elsewhere.send, elsewhere.refs.resolve(otherUser).backendNodeId, { button: "middle" });
        if (!(await valueIn(elsewhere, "document.querySelector('[name=user]').value")).includes("primary-probe"))
            t.diagnostic("middle-click paste of a selection from another context did not work in this Chromium, so the check above shows nothing; repeat it in the manual acceptance");
        await pool.close(probe.id, "test");
        await pool.close(elsewhere.id, "test");

        assert.ok(!(await tool("browser_screenshot")).isError, "a screenshot is allowed while the filled field still hides its value");
        assert.strictEqual((await tool("browser_evaluate", { expression: "document.title = 'evaluated'" })).isError, true);
        const popupId = await openPopup(bed, session, ref('button "Open popup"'));
        const fromPopup = await call(browserTools, "browser_evaluate", { sessionId: popupId, expression: "window.opener.document.title = 'evaluated'" });
        assert.strictEqual(fromPopup.isError, true, "the popup shares the filled context");
        assert.strictEqual(await valueIn(session, "document.title"), "Vault login");
        await call(browserTools, "browser_close", { sessionId: popupId });

        const shown = await tool("browser_click", { ref: ref('button "Show password"') });
        assert.strictEqual(await valueIn(session, "document.getElementById('pass').type"), "text");
        assert.match(text(shown), /- textbox "Password" \[ref=e\d+\] value="••••"/);
        assert.ok(!text(shown).includes(SECRET));
        assert.strictEqual((await tool("browser_screenshot")).isError, true, "the shown password must not reach a screenshot");

        const cached = await open(`${bases.a}/login`);
        const cachedSnapshot = await snapshotOf(cached);
        assert.ok(!(await fill(cached, { passwordRef: refOf(cachedSnapshot, 'textbox "Password"') })).isError);
        await call(browserTools, "browser_click", { sessionId: cached.id, ref: refOf(cachedSnapshot, 'button "Show password"') });
        await valueIn(cached, "window.bfcacheMarker = true");
        await call(browserTools, "browser_navigate", { sessionId: cached.id, url: `${bases.a}/popup` });
        await valueIn(cached, "history.back()");
        await until(() => valueIn(cached, "location.pathname === '/login' && document.readyState === 'complete'").catch(() => false));
        await cached.settle();
        if (await valueIn(cached, "window.bfcacheMarker === true"))
            refused(text, await call(browserTools, "browser_screenshot", { sessionId: cached.id }), "vault.screenshot_locked");
        else
            t.diagnostic("the login page did not come back from the back/forward cache in this Chromium, so the screenshot lock after history.back() was not checked; repeat it in the manual acceptance");
        await pool.close(cached.id, "test");

        // What a PATCH with a changed origin does: the entry's stored values are gone.
        vaultBed.state.secrets.clear();
        await tool("browser_click", { ref: ref('button "Sign in"') });
        const after = await tool("browser_snapshot");
        assert.match(text(after), /URL: \S*pass=••••/);
        assert.match(text(after), /Title: Signed in ••••/);
        const listed = await call(browserTools, "browser_list", {});
        await tool("browser_click", { ref: refOf(text(after), 'link "Back"') });

        const leaks = [SECRET, encodeURIComponent(SECRET), new URLSearchParams({ pass: SECRET }).toString().slice("pass=".length)];
        for (const [where, output] of [["snapshot", text(after)], ["browser_list", text(listed)], ["audit", JSON.stringify(audit)]])
            for (const leak of leaks) assert.ok(!output.includes(leak), `${where} contains the password as ${leak}`);
        await pool.close(session.id, "test");
    });

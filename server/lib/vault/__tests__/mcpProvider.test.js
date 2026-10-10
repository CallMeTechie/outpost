process.env.VAULT_KEY = "ab".repeat(32);
const test = require("node:test");
const assert = require("node:assert");
const bed = require("./helpers/vaultBed");
const { BrowserSession } = require("../../browser/BrowserSession");
const { BrowserPool } = require("../../browser/BrowserPool");
const { createFakeCdp, flush } = require("../../browser/__tests__/helpers/fakeCdp");
const { createBrowserTools } = require("../../browser/tools");
const vaultGuard = require("../../browser/vaultGuard");
const { createMcpServer } = require("../../mcp/server");
const { Permission } = require("../../../permissions/registry");
const { VaultError, VaultErrorCode } = require("../errors");
const { createVaultProvider } = require("../mcpProvider");

const FILL = "browser_fill_credential";
const SECRET = "hunter2-vault";
const LOGIN = {
    id: 41, accountId: 1, organizationId: null, name: "github", type: "login", description: null,
    fields: { username: "ada", origins: ["https://login.test"] }, approvalRequired: false, allServers: true,
};
const ORG_API = {
    id: 42, accountId: null, organizationId: 3, name: "shop-api", type: "api_key", description: "Shop API",
    fields: { hosts: ["api.shop.test"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}" }, approvalRequired: true, allServers: true,
};

const fakePage = () => {
    const page = {
        nodes: new Map([
            [11, { origin: "https://login.test", ancestors: [], input: true, type: "password", connected: true }],
            [12, { origin: "https://login.test", ancestors: [], input: true, type: "text", connected: true }],
        ]),
        focused: null,
        holdFocus: false,
    };
    const nodeId = (objectId) => Number(objectId.slice("node-".length));
    const cdp = createFakeCdp({
        "DOM.resolveNode": ({ backendNodeId }) => ({ object: { objectId: `node-${backendNodeId}` } }),
        "Runtime.evaluate": ({ expression }) => (expression === "document" ? { result: { objectId: "document" } } : { result: { value: 1 } }),
        "Runtime.callFunctionOn": ({ objectId }) => {
            if (objectId !== "document") return { result: { value: page.nodes.get(nodeId(objectId)) } };
            return { result: page.focused === null ? { type: "object", subtype: "null", value: null } : { objectId: `node-${page.focused}` } };
        },
        "DOM.describeNode": ({ objectId }) => ({ node: { backendNodeId: nodeId(objectId), nodeName: "INPUT" } }),
        "DOM.focus": ({ backendNodeId }) => {
            if (!page.holdFocus) page.focused = backendNodeId;
            return {};
        },
    });
    return { page, cdp };
};

let opened = 0;
const openSession = (cdp) => {
    opened += 1;
    const session = new BrowserSession({
        id: `browser-${opened}`, accountId: 1, profile: "ephemeral", origin: "agent", cdp, targetId: `T${opened}`, cdpSessionId: `S${opened}`,
    });
    session.keyId = null;
    session.contextKey = `ctx-${opened}`;
    session.state.url = "https://login.test/signin";
    session.refs.assign(11, 'textbox "Password"');
    session.refs.assign(12, 'textbox "User"');
    return session;
};

const fakePool = (sessions) => {
    const mine = (accountId, keyId) => sessions.filter((s) => s.accountId === accountId && (keyId === null || s.keyId === keyId));
    return {
        getOwned: (accountId, id, { keyId = null } = {}) => mine(accountId, keyId).find((s) => s.id === id) ?? null,
        listForCaller: ({ accountId, keyId = null }) => mine(accountId, keyId).map((s) => s.summary()),
        listForAccount: (accountId) => mine(accountId, null).map((s) => s.summary()),
    };
};

const fakeApprovals = () => {
    const open = [];
    return {
        open,
        requestApproval: (request) => {
            if (open.some((o) => o.request.transportId === request.transportId && o.request.item.id === request.item.id))
                return Promise.reject(new VaultError(VaultErrorCode.APPROVAL_PENDING, undefined, { early: true }));
            return new Promise((resolve) => {
                const pending = {
                    request,
                    answer: (decision) => {
                        open.splice(open.indexOf(pending), 1);
                        resolve(decision);
                    },
                };
                open.push(pending);
            });
        },
        forgetTransport: () => {},
    };
};

const setup = ({ items = [LOGIN], permissions = [Permission.VAULT_USE, Permission.CONNECT_BROWSER] } = {}) => {
    bed.reset({ items, secrets: { "41:password": SECRET, "42:token": "tok-123-secret" }, permissions, orgs: [{ id: 3, name: "Shop GmbH" }], apiKeys: [99] });
    const { page, cdp } = fakePage();
    const session = openSession(cdp);
    const pool = fakePool([session]);
    const audit = [];
    const record = async (entry) => { audit.push(entry); };
    const browserTools = createBrowserTools({ getPool: () => pool, audit: record });
    const approvals = fakeApprovals();
    const provider = createVaultProvider({ getBrowserTools: () => browserTools, approvals, audit: record });
    const ctx = (transportId = "A") => ({
        accountId: 1, keyId: null, agent: null, impersonatorId: null, transportId, ipAddress: "10.0.0.1", userAgent: "claude-code", signal: new AbortController().signal,
    });
    const text = (result) => result.content.map((c) => c.text).join("");
    const typed = () => cdp.callsOf("Input.insertText").map((call) => call.params.text);
    const vaultAudit = () => audit.filter((entry) => entry.action.startsWith("vault."));
    return { page, cdp, session, pool, audit, vaultAudit, browserTools, approvals, provider, ctx, text, typed };
};

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await flush();
    assert.ok(condition(), "condition not reached");
};

const rpc = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params });

test("vault_list names every visible entry without a stored value; organization entries as org:<id>/<name>", async () => {
    const { provider, ctx, text } = setup({ items: [LOGIN, ORG_API] });
    const result = await provider.call("vault_list", {}, ctx());

    const serialized = JSON.stringify(result);
    for (const value of [SECRET, "tok-123-secret"]) assert.ok(!serialized.includes(value), `vault_list leaks ${value}`);
    assert.strictEqual(bed.state.secretReads, 0, "vault_list never decrypts");
    assert.deepStrictEqual(JSON.parse(text(result)), [
        {
            item: "github", owner: "personal", type: "login", description: null, username: "ada",
            origins: ["https://login.test"], approvalRequired: false, usableBy: ["browser_fill_credential"],
        },
        {
            item: "org:3/shop-api", owner: "Shop GmbH", type: "api_key", description: "Shop API",
            hosts: ["api.shop.test"], approvalRequired: true, usableBy: [],
        },
    ]);
});

test("an approval answered after more than 90 s still fills: the wait runs outside runAgent and leaves the session free; an impersonated call always asks", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const env = setup({ items: [{ ...LOGIN, approvalRequired: true }] });
    const pending = env.provider.call(FILL, { item: "github", passwordRef: "e1", usernameRef: "e2" }, env.ctx("A"));
    await until(() => env.approvals.open.length === 1);
    assert.strictEqual(env.session.agentTool, null, "nobody holds the session while the user decides");
    assert.strictEqual(env.approvals.open[0].request.target, "https://login.test");

    const second = await env.provider.call(FILL, { item: "github", passwordRef: "e1" }, env.ctx("A"));
    assert.match(env.text(second), /\(vault\.approval_pending\)$/, "a second call meets the open approval, not a busy session");

    t.mock.timers.tick(100_000);
    env.approvals.open[0].answer("once");
    const result = await pending;

    assert.strictEqual(env.text(result), "Filled username and password of github.");
    assert.deepStrictEqual(env.typed(), ["ada", SECRET]);
    assert.ok(vaultGuard.isFilled(env.session.contextKey));
    assert.deepStrictEqual(env.vaultAudit().map((entry) => [entry.action, entry.details.code]),
        [["vault.use_denied", "vault.approval_pending"], ["vault.use", undefined]]);
    const use = env.vaultAudit().find((entry) => entry.action === "vault.use");
    assert.deepStrictEqual([use.resource, use.resourceId, use.details.item, use.details.target, use.details.approval],
        ["vault", 41, "github", "https://login.test", "once"]);
    assert.ok(!JSON.stringify(env.audit).includes(SECRET));
    assert.deepStrictEqual(bed.state.updates.map(({ where, silent }) => ({ where, silent })), [{ where: { id: 41 }, silent: true }], "updatedAt stays, a session approval keeps matching");

    bed.state.items[0].approvalRequired = false;
    const impersonated = env.provider.call(FILL, { item: "github", passwordRef: "e1" }, { ...env.ctx("B"), impersonatorId: 7 });
    await until(() => env.approvals.open.length === 1);
    env.approvals.open[0].answer("once");
    assert.strictEqual(env.text(await impersonated), "Filled password of github.", "an impersonated call waits for the user even where the entry needs no approval");
});

test("after the approval every check runs again with the entry as it is now; a failure types nothing and is audited after_approval", async () => {
    const cases = [
        ["browser_evaluate in the session", "vault.session_tainted", async (env) => {
            const evaluated = await env.browserTools.call("browser_evaluate", { expression: "1", sessionId: env.session.id }, env.ctx("A"));
            assert.ok(!evaluated.isError, "the session is free for other tools while the user decides");
        }],
        ["the membership that made the entry visible ends", "vault.item_unknown", () => {
            bed.state.items = [];
        }],
        ["an origin is added to the entry", "vault.origin_mismatch", () => {
            bed.state.items[0].fields = { ...LOGIN.fields, origins: [...LOGIN.fields.origins, "https://other.test"] };
        }],
        ["the key of the connection is revoked", "vault.item_unknown", () => {
            bed.state.apiKeys.clear();
        }],
    ];
    for (const [change, code, during] of cases) {
        const env = setup({ items: [{ ...LOGIN, approvalRequired: true }] });
        const pending = env.provider.call(FILL, { item: "github", passwordRef: "e1", usernameRef: "e2" }, { ...env.ctx("A"), keyId: 99 });
        await until(() => env.approvals.open.length === 1);
        await during(env);
        env.approvals.open[0].answer("once");
        const result = await pending;

        assert.strictEqual(result.isError, true, change);
        assert.ok(env.text(result).endsWith(`(${code})`), `${change}: ${env.text(result)}`);
        assert.deepStrictEqual(env.typed(), [], change);
        const denied = env.vaultAudit().find((entry) => entry.action === "vault.use_denied");
        assert.deepStrictEqual([denied.details.code, denied.details.stage, denied.details.target, denied.details.item],
            [code, "after_approval", "https://login.test", "github"], change);
    }
});

test("without connect.browser the MCP endpoint lists only vault_list and answers browser_fill_credential as an unknown tool", async () => {
    const env = setup({ permissions: [Permission.VAULT_USE] });
    const mcp = createMcpServer({ providers: [env.provider] });
    const init = await mcp.handle({
        body: rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } }), accountId: 1,
    });
    const transportId = init.headers["Mcp-Session-Id"];
    const names = async () => (await mcp.handle({ body: rpc(2, "tools/list"), transportId, accountId: 1 })).body.result.tools.map((tool) => tool.name);

    assert.deepStrictEqual(await names(), ["vault_list"]);
    const called = await mcp.handle({ body: rpc(3, "tools/call", { name: FILL, arguments: { item: "github", passwordRef: "e1" } }), transportId, accountId: 1 });
    assert.strictEqual(called.body.error.code, -32602);
    assert.deepStrictEqual(env.typed(), []);

    bed.state.permissions.add(Permission.CONNECT_BROWSER);
    assert.deepStrictEqual(await names(), ["vault_list", FILL]);
});

test("when the page keeps the focus on another element the fill stops with vault.focus_lost before Input.insertText", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const env = setup();
    await env.provider.call(FILL, { item: "x".repeat(5000), passwordRef: "e1" }, env.ctx("A"));
    await env.provider.call(FILL, { item: { big: "y".repeat(5000) }, passwordRef: "e1" }, env.ctx("A"));
    assert.deepStrictEqual(env.vaultAudit().map((entry) => entry.details.item?.length ?? null), [200, null], "invalid arguments never reach the audit in full");
    env.audit.length = 0;
    env.page.focused = 99;
    env.page.holdFocus = true;
    const result = await env.provider.call(FILL, { item: "github", passwordRef: "e1" }, env.ctx("A"));

    assert.match(env.text(result), /\(vault\.focus_lost\)$/);
    assert.strictEqual(env.cdp.callsOf("Input.insertText").length, 0);
    assert.strictEqual(env.vaultAudit().find((entry) => entry.action === "vault.use_denied").details.code, "vault.focus_lost");

    for (let i = 3; i < 20; i++) await env.provider.call(FILL, { item: "github", passwordRef: "e1" }, env.ctx("A"));
    const limited = await env.provider.call(FILL, { item: "github", passwordRef: "e1" }, env.ctx("A"));
    const again = await env.provider.call(FILL, { item: "github", passwordRef: "e1" }, env.ctx("A"));
    assert.match(env.text(limited), /\(vault\.rate_limited\)$/);
    assert.match(env.text(again), /\(vault\.rate_limited\)$/);
    assert.deepStrictEqual(env.vaultAudit().filter((entry) => entry.details.code === "vault.rate_limited").length, 1, "one audit row per caller and minute");
});

test("an agent key fills only in its own sessions: a foreign sessionId answers like an unknown one, none falls back to another's session", async () => {
    bed.reset({ items: [LOGIN], secrets: { "41:password": SECRET }, permissions: [Permission.VAULT_USE, Permission.CONNECT_BROWSER] });
    let targets = 0;
    let contexts = 0;
    const instances = [];
    const launcher = {
        started: [],
        async start({ key }) {
            launcher.started.push(key);
            return { key, port: 9222 + launcher.started.length };
        },
        async stop() {},
        async endpoint(port) { return `ws://10.0.0.7:${port}/devtools/browser/x`; },
    };
    const connectCdp = async () => {
        const cdp = createFakeCdp({
            "Target.createBrowserContext": () => ({ browserContextId: `ctx-${++contexts}` }),
            "Target.createTarget": () => ({ targetId: `T${++targets}` }),
            "Target.attachToTarget": ({ targetId }) => ({ sessionId: `S-${targetId}` }),
        });
        instances.push(cdp);
        return cdp;
    };
    const pool = new BrowserPool({
        getSettings: async () => ({ enabled: true, maxSessions: 4, idleMinutes: 30, callbackHost: "outpost" }), launcher, connectCdp,
        createVia: async () => { throw new Error("no via in this test"); },
    });
    const audit = [];
    const record = async (entry) => { audit.push(entry); };
    const browserTools = createBrowserTools({ getPool: () => pool, audit: record });
    const provider = createVaultProvider({ getBrowserTools: () => browserTools, approvals: fakeApprovals(), audit: record });
    const { session: users } = await pool.open({ accountId: 1, origin: "user" });
    const { session: theirs } = await pool.open({ accountId: 1, keyId: 8 });
    const agent = {
        accountId: 1, keyId: 41, agent: { keyId: 41, entryId: 7, agentType: "claude" }, impersonatorId: null,
        transportId: "T41", ipAddress: "10.0.0.5", userAgent: "claude-code", signal: new AbortController().signal,
    };
    const fillIn = async (sessionId) => {
        const result = await provider.call(FILL, { item: "github", passwordRef: "e1", ...(sessionId && { sessionId }) }, agent);
        assert.strictEqual(result.isError, true);
        return result.content.map((c) => c.text).join("");
    };

    const unknown = await fillIn("browser-unknown");
    for (const foreign of [users.id, theirs.id])
        assert.strictEqual((await fillIn(foreign)).replace(foreign, "X"), unknown.replace("browser-unknown", "X"), "a foreign session answers like an unknown one");
    const none = await fillIn(null);
    assert.match(none, /No browser session is open/);
    assert.ok(![users.id, theirs.id].some((id) => none.includes(id)), "neither the user's nor the other key's session is taken or named");

    for (const method of ["DOM.focus", "Input.insertText"])
        assert.deepStrictEqual(instances.flatMap((cdp) => cdp.callsOf(method)), [], method);
    assert.strictEqual(bed.state.secretReads, 0);
    assert.deepStrictEqual(audit.filter((entry) => entry.action === "vault.use_denied").map((entry) => entry.details.code),
        ["UNKNOWN_SESSION", "UNKNOWN_SESSION", "UNKNOWN_SESSION", "NO_SESSION"]);
});

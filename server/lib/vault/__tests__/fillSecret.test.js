process.env.VAULT_KEY = "ab".repeat(32);
const test = require("node:test");
const assert = require("node:assert");
const bed = require("./helpers/vaultBed");
const { BrowserPool } = require("../../browser/BrowserPool");
const { createBrowserTools } = require("../../browser/tools");
const vaultGuard = require("../../browser/vaultGuard");
const { createFakeCdp, flush } = require("../../browser/__tests__/helpers/fakeCdp");
const { Permission } = require("../../../permissions/registry");
const { VaultErrorCode } = require("../errors");

const { createVaultProvider } = require("../mcpProvider");

const FILL = "browser_fill_secret";
const TOKEN = "ghp_Fo4ms+Tok/en42";
const VALUE = "recovery code 7731";
const UPDATED = "2026-10-10T08:00:00.000Z";
const API = {
    id: 61, accountId: 1, organizationId: null, name: "forms-token", type: "api_key", description: null, updatedAt: UPDATED,
    fields: { hosts: ["api.forms.test"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}", fillOrigins: ["https://forms.test"] },
    approvalRequired: false, allServers: true,
};
const OTHER = {
    id: 62, accountId: 1, organizationId: null, name: "recovery", type: "generic", description: null, updatedAt: UPDATED,
    fields: { fillOrigins: [] }, approvalRequired: false, allServers: true,
};

const FORMS = "https://forms.test";
const field = (backendNodeId, name, { tag = "input", type = "text", origin = FORMS, ancestors = [], role = "textbox" } = {}) => ({
    backendNodeId, name, role, tag, type, origin, ancestors,
});
const makeFields = () => [
    field(51, "API token"),
    field(52, "Secret", { type: "password" }),
    field(53, "Notes", { tag: "textarea", type: null, ancestors: ["https://ads.evil.test"] }),
    field(54, "Scope", { tag: "select", type: null, role: "combobox" }),
];

const fakeApprovals = () => {
    const open = [];
    return {
        open,
        requestApproval: (request) => new Promise((resolve) => {
            const pending = { request, answer: (decision) => { open.splice(open.indexOf(pending), 1); resolve(decision); } };
            open.push(pending);
        }),
        forgetSession: () => {},
        forgetTransport: () => {},
    };
};

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await flush();
    assert.ok(condition(), "condition not reached");
};

const setup = async () => {
    vaultGuard._resetForTests();
    bed.reset({
        items: [API, OTHER], secrets: { "61:token": TOKEN, "62:value": VALUE },
        permissions: [Permission.VAULT_USE, Permission.CONNECT_BROWSER], apiKeys: [41], entries: [{ id: 7, name: "web01" }],
    });
    const FIELDS = makeFields();
    const page = { values: new Map(), types: new Map(FIELDS.map((f) => [f.backendNodeId, f.type])), focused: null, inserted: [], session: null };
    const byId = (id) => FIELDS.find((f) => f.backendNodeId === id);
    const nodeId = (objectId) => Number(objectId.slice("node-".length));
    const domNode = (f) => ({
        backendNodeId: f.backendNodeId, localName: f.tag, nodeName: f.tag.toUpperCase(),
        attributes: f.tag === "input" ? ["type", page.types.get(f.backendNodeId)] : [],
    });
    const connectCdp = async () => createFakeCdp({
        "Target.createBrowserContext": () => ({ browserContextId: "ctx-1" }),
        "Target.createTarget": () => ({ targetId: "T1" }),
        "Target.attachToTarget": ({ targetId }) => ({ sessionId: `S-${targetId}` }),
        "Page.getNavigationHistory": { currentIndex: 0, entries: [{ id: 1, url: `${FORMS}/settings/tokens`, title: "Tokens" }] },
        "Accessibility.getFullAXTree": () => ({
            nodes: [
                { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Tokens" }, childIds: FIELDS.map((f) => String(f.backendNodeId)) },
                ...FIELDS.map((f) => ({
                    nodeId: String(f.backendNodeId), parentId: "1", childIds: [], role: { value: f.role }, name: { value: f.name },
                    backendDOMNodeId: f.backendNodeId, value: { type: "string", value: page.values.get(f.backendNodeId) ?? "" },
                })),
            ],
        }),
        "DOM.getFlattenedDocument": () => ({ nodes: FIELDS.map(domNode) }),
        "DOM.resolveNode": ({ backendNodeId }) => ({ object: { objectId: `node-${backendNodeId}` } }),
        "DOM.describeNode": ({ objectId, backendNodeId }) => (objectId
            ? { node: { backendNodeId: nodeId(objectId), nodeName: byId(nodeId(objectId)).tag.toUpperCase() } }
            : { node: domNode(byId(backendNodeId)) }),
        "Runtime.evaluate": ({ expression }) => (expression === "document" ? { result: { objectId: "document" } } : { result: { value: "complete" } }),
        "Runtime.callFunctionOn": ({ objectId }) => {
            if (objectId === "document")
                return { result: page.focused === null ? { type: "object", subtype: "null", value: null } : { objectId: `node-${page.focused}` } };
            const f = byId(nodeId(objectId));
            return { result: { value: {
                origin: f.origin, ancestors: f.ancestors, input: f.tag === "input", textarea: f.tag === "textarea",
                type: f.tag === "input" ? page.types.get(f.backendNodeId) : null, connected: true,
            } } };
        },
        "DOM.focus": ({ backendNodeId }) => {
            page.focused = backendNodeId;
            return {};
        },
        "Input.insertText": ({ text }) => {
            page.inserted.push({ text, filledBefore: vaultGuard.isFilled(page.session.contextKey) });
            page.values.set(page.focused, text);
            return {};
        },
        "DOM.getContentQuads": { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] },
        "Page.getLayoutMetrics": { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } },
        "Page.captureScreenshot": { data: "UE5H" },
    });
    const launcher = {
        async start({ key }) { return { key, port: 9300 }; },
        async stop() {},
        async endpoint(port) { return `ws://10.0.0.7:${port}/devtools/browser/x`; },
    };
    const pool = new BrowserPool({ getSettings: async () => ({ enabled: true, maxSessions: 4, idleMinutes: 30 }), launcher, connectCdp });
    pool.onContextEnded(vaultGuard.forgetContext);
    const audit = [];
    const record = async (entry) => { audit.push(entry); };
    const tools = createBrowserTools({ getPool: () => pool, audit: record, sleep: async () => {} });
    const approvals = fakeApprovals();
    const provider = createVaultProvider({ getBrowserTools: () => tools, approvals, audit: record });
    const agent = {
        accountId: 1, keyId: 41, agent: { keyId: 41, entryId: 7, agentType: "claude" }, impersonatorId: null,
        transportId: "T41", ipAddress: "10.0.0.5", userAgent: "claude-code", signal: new AbortController().signal,
    };
    const text = (result) => result.content.map((c) => c.text ?? "").join("");
    const opened = text(await tools.call("browser_open", { url: `${FORMS}/settings/tokens` }, agent));
    page.session = pool.get(/^Session: (\S+)/m.exec(opened)[1]);
    const refs = Object.fromEntries(FIELDS.map((f) => [f.name, new RegExp(`"${f.name}" \\[ref=(e\\d+)\\]`).exec(opened)[1]]));
    const fill = (args) => provider.call(FILL, args, agent);
    const vaultAudit = () => audit.filter((entry) => entry.action.startsWith("vault."));
    return { page, fields: FIELDS, tools, provider, approvals, agent, text, refs, fill, audit, vaultAudit };
};

test("a token goes into a field on one of its fill origins; markFilled runs before Input.insertText and the snapshot shows ••••", async () => {
    const env = await setup();
    const result = await env.fill({ item: "forms-token", ref: env.refs["API token"] });

    assert.strictEqual(env.text(result), "Filled the value of forms-token into the field.");
    assert.deepStrictEqual(env.page.inserted, [{ text: TOKEN, filledBefore: true }]);
    const snapshot = env.text(await env.tools.call("browser_snapshot", {}, env.agent));
    assert.match(snapshot, /- textbox "API token" \[ref=e\d+\] value="••••"/);
    assert.ok(!snapshot.includes(TOKEN));
    const use = env.vaultAudit().find((entry) => entry.action === "vault.use");
    assert.deepStrictEqual([use.resourceId, use.details.tool, use.details.access, use.details.origin, use.details.fieldType],
        [61, FILL, "write", FORMS, "text"]);
    assert.ok(!JSON.stringify(env.audit).includes(TOKEN));
});

test("refused without typing or decrypting: a textarea in a frame of the fill origin inside a foreign page, a select, an entry without fill origins", async () => {
    const cases = [
        ["textarea of forms.test embedded in ads.evil.test", { item: "forms-token", ref: "Notes" }, VaultErrorCode.ORIGIN_MISMATCH],
        ["select on the fill origin", { item: "forms-token", ref: "Scope" }, VaultErrorCode.FIELD_NOT_FILLABLE],
        ["generic entry without fill origins, fillAnywhere off", { item: "recovery", ref: "API token" }, VaultErrorCode.NO_FILL_ORIGINS],
    ];
    for (const [label, { item, ref }, code] of cases) {
        const env = await setup();
        const result = await env.fill({ item, ref: env.refs[ref] });

        assert.strictEqual(result.isError, true, label);
        assert.ok(env.text(result).endsWith(`(${code})`), `${label}: ${env.text(result)}`);
        assert.deepStrictEqual([env.page.inserted, bed.state.secretReads, env.approvals.open.length], [[], 0, 0], label);
        assert.deepStrictEqual(env.vaultAudit().map((entry) => [entry.action, entry.details.code]), [["vault.use_denied", code]], label);
    }
});

test("a filled field that is not a password field locks browser_screenshot; a filled password field does not", async () => {
    const env = await setup();
    await env.fill({ item: "forms-token", ref: env.refs.Secret });
    assert.ok(!(await env.tools.call("browser_screenshot", {}, env.agent)).isError, "the value sits in a password field");

    await env.fill({ item: "forms-token", ref: env.refs["API token"] });
    const refused = await env.tools.call("browser_screenshot", {}, env.agent);
    assert.strictEqual(refused.isError, true);
    assert.match(env.text(refused), /\(vault\.screenshot_locked\)$/);
});

test("with fillAnywhere an entry without fill origins asks even without approvalRequired, for this one origin", async () => {
    const env = await setup();
    bed.state.settings.fillAnywhere = true;
    const pending = env.fill({ item: "recovery", ref: env.refs.Notes });
    await until(() => env.approvals.open.length === 1);

    const { request } = env.approvals.open[0];
    assert.deepStrictEqual([request.tool, request.access, request.target, request.scope], [FILL, "write", FORMS, `fill|${FORMS}`]);
    assert.deepStrictEqual(env.page.inserted, [], "nothing is typed while the card is open");
    env.approvals.open[0].answer("once");

    assert.strictEqual(env.text(await pending), "Filled the value of recovery into the field.");
    assert.deepStrictEqual(env.page.inserted.map((entry) => entry.text), [VALUE]);

    const moved = await setup();
    bed.state.settings.fillAnywhere = true;
    const asking = moved.fill({ item: "recovery", ref: moved.refs.Notes });
    await until(() => moved.approvals.open.length === 1);
    moved.fields[2].origin = "https://other.test";
    moved.approvals.open[0].answer("once");

    const stale = await asking;
    assert.ok(moved.text(stale).endsWith(`(${VaultErrorCode.APPROVAL_STALE})`), moved.text(stale));
    assert.deepStrictEqual([moved.page.inserted, bed.state.secretReads], [[], 0], "the value is not read once the field moved after the card");
});

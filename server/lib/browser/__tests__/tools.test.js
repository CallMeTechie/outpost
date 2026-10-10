const test = require("node:test");
const assert = require("node:assert");
const { createBrowserTools } = require("../tools");
const { BrowserError, BrowserErrorCode } = require("../errors");

const fakeSession = (id, accountId) => ({
    id, accountId, organizationId: null, via: null, paused: false,
    state: { url: `https://${id}.test/`, title: id },
    calls: [],
    async runAgent(tool, fn) {
        if (this.paused) throw new BrowserError(BrowserErrorCode.PAUSED, "The session is paused by the user. Wait and try again later.");
        return fn(this);
    },
    async settle() {},
    async snapshot() { return '- textbox "Password" [ref=e1]'; },
    labelOf(ref) {
        if (ref !== "e1") throw new BrowserError(BrowserErrorCode.STALE_REF, `Reference ${ref} is from an older snapshot; take a new snapshot`);
        return 'textbox "Password"';
    },
    async click(ref) { this.calls.push(["click", ref]); },
    async type(ref, text) { this.calls.push(["type", ref, text]); },
    async evaluate() { return { ok: true }; },
    summary() { return { id, url: this.state.url, title: id }; },
});

const fakePool = () => {
    const sessions = new Map();
    let counter = 0;
    return {
        sessions,
        async open({ accountId, url }) {
            const session = fakeSession(`browser-${++counter}`, accountId);
            session.state.url = url;
            sessions.set(session.id, session);
            return { session, navigationError: null };
        },
        getOwned(accountId, id) {
            const session = sessions.get(id);
            return session && session.accountId === accountId ? session : null;
        },
        listForCaller: ({ accountId }) => [...sessions.values()].filter((s) => s.accountId === accountId).map((s) => s.summary()),
        async close(id) { sessions.delete(id); },
    };
};

const setup = () => {
    const pool = fakePool();
    const audit = [];
    const tools = createBrowserTools({ getPool: () => pool, audit: async (entry) => { audit.push(entry); } });
    const ctx = (transportId, accountId = 1) => ({ accountId, transportId, ipAddress: "10.0.0.1", userAgent: "claude-code" });
    const text = (result) => result.content.map((c) => c.text).join("");
    return { pool, audit, tools, ctx, text };
};

test("without sessionId each connection keeps its own session and never takes one another connection opened", async () => {
    const { pool, tools, ctx, text } = setup();
    await tools.call("browser_open", { url: "https://one.test/" }, ctx("A"));
    await tools.call("browser_open", { url: "https://two.test/" }, ctx("B"));
    await tools.call("browser_click", { ref: "e1" }, ctx("A"));
    assert.deepStrictEqual(pool.sessions.get("browser-1").calls, [["click", "e1"]]);
    assert.deepStrictEqual(pool.sessions.get("browser-2").calls, []);

    const refused = await tools.call("browser_snapshot", {}, ctx("C"));
    assert.strictEqual(refused.isError, true);
    assert.match(text(refused), /browser-1[\s\S]*browser-2/);

    await tools.call("browser_close", {}, ctx("B"));
    const notTheirs = await tools.call("browser_snapshot", {}, ctx("C"));
    assert.strictEqual(notTheirs.isError, true, "the only open session belongs to connection A");
    assert.deepStrictEqual(pool.sessions.get("browser-1").calls, [["click", "e1"]]);

    tools.forgetTransport("A");
    const unclaimed = await tools.call("browser_snapshot", {}, ctx("C"));
    assert.match(text(unclaimed), /^Session: browser-1/);
});

test("a connection whose own session ended is not switched to another process's session", async () => {
    const { pool, tools, ctx, text } = setup();
    await tools.call("browser_open", { url: "https://mine.test/" }, ctx("A"));
    await tools.call("browser_open", { url: "https://theirs.test/" }, ctx("B"));
    await pool.close("browser-1");

    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await tools.call("browser_click", { ref: "e1" }, ctx("A"));
        assert.strictEqual(result.isError, true);
        assert.match(text(result), /browser-1 has ended/);
    }
    assert.deepStrictEqual(pool.sessions.get("browser-2").calls, []);

    const explicit = await tools.call("browser_click", { ref: "e1", sessionId: "browser-2" }, ctx("A"));
    assert.ok(!explicit.isError, "naming the session explicitly still works");
});

test("actions are audited with URL, tool and labelled target; typed text and URL credentials never, expressions cut to 500", async () => {
    const { tools, ctx, audit } = setup();
    await tools.call("browser_open", { url: "https://admin:s3cret@login.test/#access_token=abc" }, ctx("A"));
    await tools.call("browser_type", { ref: "e1", text: "hunter2" }, ctx("A"));
    await tools.call("browser_click", { ref: "e1" }, ctx("A"));
    await tools.call("browser_snapshot", {}, ctx("A"));
    await tools.call("browser_evaluate", { expression: `"${"x".repeat(600)}"` }, ctx("A"));

    assert.deepStrictEqual(audit.map((entry) => entry.action), ["browser.open", "browser.type", "browser.click", "browser.evaluate"]);
    const [open, type, click, evaluate] = audit;
    assert.deepStrictEqual(open.details, { url: "https://login.test/", sessionId: "browser-1", tool: "browser_open", via: null });
    assert.deepStrictEqual(type.details, { url: "https://login.test/", sessionId: "browser-1", tool: "browser_type", target: 'textbox "Password"' });
    assert.ok(!JSON.stringify(audit).includes("hunter2"));
    assert.ok(!JSON.stringify(audit).includes("s3cret"));
    assert.ok(!JSON.stringify(audit).includes("access_token"));
    assert.strictEqual(click.details.target, 'textbox "Password"');
    assert.strictEqual(evaluate.details.expression.length, 500);
    assert.strictEqual(evaluate.details.expressionLength, 602);
    assert.match(evaluate.details.expressionSha256, /^[0-9a-f]{64}$/);
    assert.deepStrictEqual([open.resource, open.accountId, open.organizationId, open.ipAddress, open.userAgent], ["browser", 1, null, "10.0.0.1", "claude-code"]);
});

test("refusals and unexpected failures reach the agent as tool errors, not protocol errors", async () => {
    const { pool, tools, ctx, text } = setup();
    await tools.call("browser_open", { url: "https://a.test/" }, ctx("A"));
    const session = pool.sessions.get("browser-1");

    session.paused = true;
    const paused = await tools.call("browser_click", { ref: "e1" }, ctx("A"));
    assert.deepStrictEqual([paused.isError, /paused by the user/.test(text(paused))], [true, true]);
    session.paused = false;

    assert.match(text(await tools.call("browser_click", { ref: "e9" }, ctx("A"))), /older snapshot/);

    session.evaluate = async () => { throw new Error("Runtime.evaluate: connection closed"); };
    const failed = await tools.call("browser_evaluate", { expression: "1" }, ctx("A"));
    assert.deepStrictEqual([failed.isError, /connection closed/.test(text(failed))], [true, true]);
});

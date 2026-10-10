const test = require("node:test");
const assert = require("node:assert");
const { BrowserPool } = require("../BrowserPool");
const { createBrowserTools } = require("../tools");
const { createFakeCdp, flush } = require("./helpers/fakeCdp");

const ENTRIES = { nas: 7, web: 8 };

const setup = ({ maxSessions = 10 } = {}) => {
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
    const createVia = async ({ via }) => ({ label: via, entryId: ENTRIES[via], organizationId: null, resolverRule: "MAP localhost:5173 outpost:40000", close() {} });
    const pool = new BrowserPool({ getSettings: async () => ({ enabled: true, maxSessions, idleMinutes: 30, callbackHost: "outpost" }), launcher, connectCdp, createVia });
    const tools = createBrowserTools({ getPool: () => pool, audit: async () => {} });
    const agent = (keyId, entryId, transportId) => ({ accountId: 1, keyId, agent: { keyId, entryId, agentType: "claude" }, transportId, ipAddress: "10.0.0.5", userAgent: "claude-code" });
    const login = (transportId) => ({ accountId: 1, keyId: null, agent: null, transportId, ipAddress: "10.0.0.9", userAgent: "firefox" });
    const accountKey = (transportId) => ({ accountId: 1, keyId: 99, agent: null, transportId, ipAddress: "10.0.0.9", userAgent: "script" });
    const text = (result) => result.content.map((c) => c.text).join("");
    const opened = (result) => /^Session: (\S+)/m.exec(text(result))[1];
    return { pool, tools, launcher, instances, agent, login, accountKey, text, opened };
};

test("an agent key lists, resolves and defaults to its own sessions and their popups only; account callers keep seeing all", async () => {
    const { pool, tools, instances, agent, login, accountKey, text, opened } = setup({ maxSessions: 5 });
    const { session: users } = await pool.open({ accountId: 1, url: "https://user.test/", origin: "user" });

    const noOwn = await tools.call("browser_snapshot", {}, agent(41, 7, "T41"));
    assert.strictEqual(noOwn.isError, true);
    assert.match(text(noOwn), /No browser session is open/);
    assert.ok(!text(noOwn).includes(users.id), "the user's unclaimed session is neither taken nor named");

    const own = opened(await tools.call("browser_open", { url: "https://a.test/" }, agent(41, 7, "T41")));
    const theirs = opened(await tools.call("browser_open", { url: "https://b.test/" }, agent(42, 8, "T42")));
    instances[0].emitEvent("Target.targetCreated", { targetInfo: { targetId: "POP", type: "page", openerId: pool.get(own).targetId } });
    await flush();
    const popup = pool.listForAccount(1).map((s) => s.id).find((id) => ![users.id, own, theirs].includes(id));

    assert.deepStrictEqual(text(await tools.call("browser_list", {}, agent(41, 7, "T41"))).split("\n").map((line) => line.split("  ")[0]),
        [`- ${own}`, `- ${popup}`]);
    assert.match(text(await tools.call("browser_snapshot", { sessionId: popup }, agent(41, 7, "T41"))), new RegExp(`^Session: ${popup}`));

    const unknown = text(await tools.call("browser_snapshot", { sessionId: "browser-unknown" }, agent(41, 7, "T41")));
    for (const foreign of [users.id, theirs]) {
        const refused = await tools.call("browser_snapshot", { sessionId: foreign }, agent(41, 7, "T41"));
        assert.strictEqual(refused.isError, true);
        assert.strictEqual(text(refused).replace(foreign, "X"), unknown.replace("browser-unknown", "X"), "a foreign session answers like an unknown one");
    }

    const full = await tools.call("browser_open", { url: "https://c.test/" }, agent(41, 7, "T41b"));
    assert.ok(!full.isError);
    const limited = text(await tools.call("browser_open", { url: "https://d.test/" }, agent(41, 7, "T41b")));
    assert.match(limited, /limit of 5/);
    assert.ok(!limited.includes(users.id) && !limited.includes(theirs), "the limit error lists only the key's own sessions");

    const everything = [users.id, own, theirs, popup, opened(full)].sort();
    for (const caller of [login("TL"), accountKey("TK")]) {
        const listed = text(await tools.call("browser_list", {}, caller)).split("\n").map((line) => line.split("  ")[0].slice(2));
        assert.deepStrictEqual(listed.sort(), everything);
    }
    assert.match(text(await tools.call("browser_snapshot", { sessionId: theirs }, login("TL"))), new RegExp(`^Session: ${theirs}`));
});

test("an agent key opens only ephemeral sessions and tunnels only through the server it belongs to", async () => {
    const { pool, tools, launcher, agent, text, opened } = setup();
    const persistent = await tools.call("browser_open", { url: "https://a.test/", profile: "persistent" }, agent(41, 7, "T41"));
    assert.strictEqual(persistent.isError, true);
    assert.match(text(persistent), /^Agent keys can only open ephemeral sessions; call browser_open without profile=persistent\.$/);
    const refused = await tools.call("browser_open", { url: "http://localhost:5173/", via: "web" }, agent(41, 7, "T41"));
    assert.strictEqual(refused.isError, true);
    assert.match(text(refused), /only tunnel through the server it was set up for/);
    assert.deepStrictEqual([launcher.started, pool.listForAccount(1)], [[], []]);

    const allowed = await tools.call("browser_open", { url: "http://localhost:5173/", via: "nas" }, agent(41, 7, "T41"));
    assert.ok(!allowed.isError);
    assert.strictEqual(pool.get(opened(allowed)).via, "nas");
});

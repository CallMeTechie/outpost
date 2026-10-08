const test = require("node:test");
const assert = require("node:assert");
const { BrowserPool } = require("../BrowserPool");
const { BrowserErrorCode } = require("../errors");
const { createFakeCdp, createFakeViewer, flush } = require("./helpers/fakeCdp");

const harness = ({ maxSessions = 4, enabled = true, launcherDown = false } = {}) => {
    let targets = 0;
    let contexts = 0;
    const instances = new Map();
    const launcher = {
        started: [],
        stopped: [],
        async start({ key, kind, hostResolverRules }) {
            if (launcherDown) throw new Error("connect ECONNREFUSED 10.0.0.7:9300");
            launcher.started.push({ key, kind, hostResolverRules });
            return { key, port: 9222 + launcher.started.length };
        },
        async stop(key) { launcher.stopped.push(key); },
        removed: [],
        async removeProfile(key) { launcher.removed.push(key); },
        async endpoint(port) { return `ws://10.0.0.7:${port}/devtools/browser/x`; },
        async resolveHost() { return "10.0.0.7"; },
    };
    const connectCdp = async (url) => {
        const cdp = createFakeCdp({
            "Target.createBrowserContext": () => ({ browserContextId: `ctx-${++contexts}` }),
            "Target.createTarget": () => ({ targetId: `T${++targets}` }),
            "Target.attachToTarget": ({ targetId }) => ({ sessionId: `S-${targetId}` }),
        });
        instances.set(url, cdp);
        return cdp;
    };
    const createVia = async ({ via }) => ({ label: via, organizationId: 5, resolverRule: "MAP localhost:5173 outpost:40000", close() {} });
    const pool = new BrowserPool({ getSettings: async () => ({ enabled, maxSessions, idleMinutes: 30, callbackHost: "outpost" }), launcher, connectCdp, createVia });
    return { pool, launcher, instances };
};

test("the session limit refuses with the account's own open sessions instead of evicting one", async () => {
    const { pool, instances } = harness({ maxSessions: 2 });
    const { session: mine } = await pool.open({ accountId: 1, url: "https://a.test/" });
    await pool.open({ accountId: 2, url: "https://b.test/" });
    await assert.rejects(pool.open({ accountId: 1, url: "https://c.test/" }), (err) =>
        err.code === BrowserErrorCode.LIMIT_REACHED && err.details.sessions.map((s) => s.id).join() === mine.id);
    const [cdp] = instances.values();
    assert.strictEqual(cdp.callsOf("Target.createTarget").length, 2);
});

test("a viewer leaving keeps the session; idle ends only unwatched sessions, and agent work resets the clock", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const { pool } = harness();
    const { session: watched } = await pool.open({ accountId: 1, url: "https://b.test/" });
    watched.addViewer(createFakeViewer());
    const { session } = await pool.open({ accountId: 1, url: "https://a.test/" });
    const viewer = createFakeViewer();
    session.addViewer(viewer);
    session.removeViewer(viewer);
    assert.ok(pool.get(session.id), "closing the tab keeps the session");

    t.mock.timers.tick(29 * 60 * 1000);
    await session.runAgent("browser_snapshot", async () => {});
    t.mock.timers.tick(29 * 60 * 1000);
    pool.sweepIdle(30 * 60 * 1000);
    assert.ok(pool.get(session.id), "agent activity reset the idle clock");

    t.mock.timers.tick(2 * 60 * 1000);
    pool.sweepIdle(30 * 60 * 1000);
    await flush();
    assert.strictEqual(pool.get(session.id), null);
    assert.deepStrictEqual(pool.listForAccount(1).map((s) => s.id), [watched.id], "a watched session never idles out");
});

test("refusals name their reason: via with a persistent profile, a disabled feature, an unreachable container", async () => {
    const { pool, launcher } = harness();
    await assert.rejects(pool.open({ accountId: 1, url: "http://localhost:5173", via: "dev-vm", profile: "persistent" }),
        (err) => err.code === BrowserErrorCode.VIA_PERSISTENT && /exclude each other/.test(err.message));
    assert.strictEqual(launcher.started.length, 0);

    await assert.rejects(harness({ enabled: false }).pool.open({ accountId: 1, url: "https://a.test/" }),
        (err) => err.code === BrowserErrorCode.UNAVAILABLE && /Settings > Browser/.test(err.message));
    await assert.rejects(harness({ launcherDown: true }).pool.open({ accountId: 1, url: "https://a.test/" }),
        (err) => err.code === BrowserErrorCode.UNAVAILABLE && /not reachable/.test(err.message) && /ECONNREFUSED/.test(err.message));
});

test("ephemeral sessions get a context each; persistent ones share their account's instance; nobody reaches another account's session", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pool, launcher, instances } = harness();
    const { session: e1 } = await pool.open({ accountId: 1, url: "https://a.test/" });
    const { session: e2 } = await pool.open({ accountId: 1, url: "https://b.test/" });
    const { session: p1 } = await pool.open({ accountId: 1, url: "https://c.test/", profile: "persistent" });
    const { session: p2 } = await pool.open({ accountId: 1, url: "https://d.test/", profile: "persistent" });

    assert.deepStrictEqual(launcher.started.map((s) => [s.key, s.kind]), [["default", "default"], ["account-1", "persistent"]]);
    const [defaultCdp, profileCdp] = instances.values();
    assert.deepStrictEqual(defaultCdp.callsOf("Target.createTarget").map((c) => c.params.browserContextId), ["ctx-1", "ctx-2"]);
    assert.strictEqual(profileCdp.callsOf("Target.createBrowserContext").length, 0);
    assert.strictEqual(profileCdp.callsOf("Target.createTarget").length, 2);
    assert.strictEqual(pool.getOwned(2, e1.id), null);
    assert.strictEqual(pool.getOwned(1, e1.id), e1);

    p1.close("test");
    await flush();
    assert.deepStrictEqual(launcher.stopped, [], "the profile instance stays while a session uses it");
    p2.close("test");
    await flush();
    assert.deepStrictEqual(launcher.stopped, [], "the profile instance lingers so Chromium can commit cookies");
    t.mock.timers.tick(60 * 1000);
    await flush();
    assert.deepStrictEqual(launcher.stopped, ["account-1"]);

    e2.close("test");
    await flush();
    assert.deepStrictEqual(defaultCdp.callsOf("Target.disposeBrowserContext").map((c) => c.params.browserContextId), ["ctx-2"]);
});

test("a persistent open during the linger reuses the instance and cancels the retire", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pool, launcher } = harness();
    const { session: first } = await pool.open({ accountId: 1, url: "https://a.test/", profile: "persistent" });
    first.close("test");
    await flush();
    t.mock.timers.tick(30 * 1000);
    const { session: second } = await pool.open({ accountId: 1, url: "https://b.test/", profile: "persistent" });

    t.mock.timers.tick(60 * 1000);
    await flush();
    assert.deepStrictEqual(launcher.started.map((s) => s.key), ["account-1"]);
    assert.deepStrictEqual(launcher.stopped, []);
    assert.ok(pool.get(second.id));
});

test("a popup of the page becomes a session of its own for the same account", async () => {
    const { pool, instances } = harness();
    const changes = [];
    pool.on("change", (accountId) => changes.push(accountId));
    const { session: opener } = await pool.open({ accountId: 3, url: "https://a.test/" });
    opener.setPaused(true);
    const [cdp] = instances.values();

    cdp.emitEvent("Target.targetCreated", { targetInfo: { targetId: "POP", type: "page", openerId: opener.targetId, url: "https://a.test/login" } });
    await flush();

    const popupSummary = pool.listForAccount(3).find((s) => s.id !== opener.id);
    const popup = pool.get(popupSummary.id);
    assert.strictEqual(popup.targetId, "POP");
    assert.strictEqual(popup.origin, "agent");
    assert.strictEqual(popup.agentPaused, true, "a popup of a paused session arrives paused");
    assert.deepStrictEqual(cdp.callsOf("Target.attachToTarget").at(-1).params, { targetId: "POP", flatten: true });
    assert.ok(changes.includes(3));
});

test("a title the page sets after loading reaches the session list", async () => {
    const { pool, instances } = harness();
    const { session } = await pool.open({ accountId: 1, url: "https://a.test/" });
    const [cdp] = instances.values();
    cdp.emitEvent("Target.targetInfoChanged", { targetInfo: { targetId: session.targetId, type: "page", url: "https://a.test/", title: "Inbox (3)" } });
    await flush();
    assert.strictEqual(pool.listForAccount(1)[0].title, "Inbox (3)");
});

test("a crashed browser instance ends its sessions and tells their viewers", async () => {
    const { pool, instances } = harness();
    const { session } = await pool.open({ accountId: 1, url: "https://a.test/" });
    const viewer = createFakeViewer();
    session.addViewer(viewer);
    const [cdp] = instances.values();

    cdp.close();
    await flush();

    assert.deepStrictEqual(viewer.json.at(-1), { type: "closed", reason: "crashed" });
    assert.strictEqual(pool.get(session.id), null);
    const { session: next } = await pool.open({ accountId: 1, url: "https://b.test/" });
    assert.ok(pool.get(next.id), "the next open starts a fresh instance");
});

test("deleting an account ends its sessions and removes its persistent profile", async () => {
    const { pool, launcher } = harness();
    const { session: mine } = await pool.open({ accountId: 1, url: "https://a.test/", profile: "persistent" });
    const { session: other } = await pool.open({ accountId: 2, url: "https://b.test/" });
    await pool.removeAccount(1);
    assert.strictEqual(pool.get(mine.id), null);
    assert.ok(pool.get(other.id));
    assert.deepStrictEqual(launcher.removed, ["account-1"]);
});

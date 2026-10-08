const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { BrowserPool } = require("../BrowserPool");
const { createLauncherClient } = require("../launcher");
const { BrowserErrorCode } = require("../errors");
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

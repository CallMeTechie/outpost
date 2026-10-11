const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const bed = require("./helpers/vaultBed");
// approvals.js destructures createAuditLog when it loads; the in-memory database has no tables.
require("../../../controllers/audit").createAuditLog = async () => {};
const stateBroadcaster = require("../../StateBroadcaster");
const approvals = require("../approvals");
const { Permission } = require("../../../permissions/registry");
const { createVaultProvider } = require("../mcpProvider");

const TOKEN = "ghp_test token/42";
const LIMIT = 256 * 1024;

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(condition(), "condition not reached");
};

const listen = async (t, handle) => {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body });
            handle(req, res);
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const host = `127.0.0.1:${server.address().port}`;
    return { seen, host, base: `http://${host}` };
};

const setup = async (t, { approvalRequired = false } = {}) => {
    const b = await listen(t, (req, res) => res.end("other origin"));
    const a = await listen(t, (req, res) => {
        const path = new URL(req.url, "http://local").pathname;
        if (path === "/echo") {
            res.writeHead(200, {
                "content-type": "application/json", etag: `"${TOKEN}"`, location: `/next?t=${encodeURIComponent(TOKEN)}`,
                "x-secret": TOKEN, "set-cookie": `s=${encodeURIComponent(TOKEN)}`,
            });
            return res.end(JSON.stringify({ authorization: req.headers.authorization, again: TOKEN, percent: encodeURIComponent(TOKEN) }));
        }
        if (path === "/hop") return res.writeHead(302, { location: "/echo" }).end();
        if (path === "/see") return res.writeHead(303, { location: "/issues" }).end();
        if (path === "/temp") return res.writeHead(307, { location: "/issues" }).end();
        if (path === "/away") return res.writeHead(302, { location: `${b.base}/steal` }).end();
        if (path === "/big") return res.writeHead(200, { "content-type": "text/plain" }).end(`${"a".repeat(LIMIT - 5)}${TOKEN}${"b".repeat(1000)}`);
        res.writeHead(201, { "content-type": "application/json" }).end('{"created":true}');
    });
    const item = (id, name, fields) => ({
        id, accountId: 1, organizationId: null, name, type: "api_key", description: null, updatedAt: "2026-10-10T08:00:00.000Z",
        fields: { hosts: [a.host], headerName: "Authorization", headerTemplate: "Bearer {{secret}}", allowHttp: true, ...fields },
        approvalRequired, allServers: true,
    });
    bed.reset({
        items: [item(51, "api", {}), item(52, "api-ro", { readOnly: true }), item(53, "api-tls", { allowHttp: false })],
        secrets: { "51:token": TOKEN, "52:token": TOKEN, "53:token": TOKEN },
        permissions: [Permission.VAULT_USE],
    });
    approvals._resetForTests();
    const audit = [];
    const provider = createVaultProvider({ getBrowserTools: () => null, approvals, audit: async (entry) => { audit.push(entry); } });
    const ctx = {
        accountId: 1, keyId: null, agent: null, impersonatorId: null, transportId: "T1", ipAddress: "10.0.0.1", userAgent: "claude-code",
        signal: new AbortController().signal,
    };
    const call = (args) => provider.call("vault_http", args, ctx);
    const text = (result) => result.content.map((c) => c.text).join("");
    return { a, b, audit, call, text };
};

test("vault_http sets the entry's header and blanks the token wherever the response repeats it; the audit has method, host and path without query", async (t) => {
    const env = await setup(t);
    const result = await env.call({ item: "api", method: "GET", url: `${env.a.base}/echo?per_page=5` });
    const shown = env.text(result);

    assert.strictEqual(result.isError, undefined, shown);
    assert.strictEqual(env.a.seen[0].authorization, `Bearer ${TOKEN}`);
    assert.match(shown, /^HTTP 200\n/);
    assert.ok(shown.split("\n").includes('etag: "••••"'), shown);
    assert.ok(shown.split("\n").includes("location: /next?t=••••"), shown);
    assert.ok(!/set-cookie|x-secret/.test(shown), "only the listed headers reach the agent");
    for (const leak of [TOKEN, encodeURIComponent(TOKEN), "ghp_test"]) assert.ok(!shown.includes(leak), `the agent sees ${leak}`);
    const use = env.audit.find((entry) => entry.action === "vault.use");
    assert.deepStrictEqual([use.details.tool, use.details.access, use.details.method, use.details.host, use.details.path, use.details.status],
        ["vault_http", "read", "GET", env.a.host, "/echo", 200]);
    assert.ok(!/per_page|ghp_test/.test(JSON.stringify(env.audit)), "no query and no token in the audit");
});

test("a redirect to another origin comes back as it is and the other host is never called; one on the same origin is followed", async (t) => {
    const env = await setup(t);
    const away = env.text(await env.call({ item: "api", method: "GET", url: `${env.a.base}/away` }));
    assert.match(away, /^HTTP 302\n/);
    assert.ok(away.split("\n").includes(`location: ${env.b.base}/steal`), away);
    assert.deepStrictEqual(env.b.seen, []);

    const hop = env.text(await env.call({ item: "api", method: "GET", url: `${env.a.base}/hop` }));
    assert.match(hop, /^HTTP 200\n/);
    assert.deepStrictEqual(env.a.seen.map((request) => [request.url, request.authorization]),
        [["/away", `Bearer ${TOKEN}`], ["/hop", `Bearer ${TOKEN}`], ["/echo", `Bearer ${TOKEN}`]]);

    env.a.seen.length = 0;
    for (const route of ["/see", "/temp"])
        assert.match(env.text(await env.call({ item: "api", method: "POST", url: `${env.a.base}${route}`, body: "payload" })), /^HTTP 201\n/);
    assert.deepStrictEqual(env.a.seen.map((request) => [request.method, request.url, request.body]),
        [["POST", "/see", "payload"], ["GET", "/issues", ""], ["POST", "/temp", "payload"], ["POST", "/issues", "payload"]]);
});

test("vault_http refuses before reading the token: foreign host, write on a read-only entry, http without allowHttp, forbidden headers, a body with GET", async (t) => {
    const env = await setup(t);
    const cases = [
        [{ item: "api", method: "GET", url: `${env.b.base}/x` }, "vault.host_not_allowed"],
        [{ item: "api-ro", method: "POST", url: `${env.a.base}/issues`, body: "{}" }, "vault.read_only"],
        [{ item: "api-tls", method: "GET", url: `${env.a.base}/echo` }, "vault.http_not_allowed"],
        [{ item: "api", method: "GET", url: `${env.a.base}/echo`, headers: { Cookie: "a=b" } }, "vault.header_not_allowed"],
        [{ item: "api", method: "GET", url: `${env.a.base}/echo`, headers: { Range: "bytes=0-9" } }, "vault.header_not_allowed"],
        [{ item: "api", method: "GET", url: `${env.a.base}/echo`, headers: { "Proxy-Authorization": "Basic eDp5" } }, "vault.header_not_allowed"],
        [{ item: "api", method: "GET", url: `${env.a.base}/echo`, body: "q=1" }, "vault.bad_body"],
    ];
    for (const [args, code] of cases) {
        const result = await env.call(args);
        assert.strictEqual(result.isError, true, code);
        assert.ok(env.text(result).endsWith(`(${code})`), `${code}: ${env.text(result)}`);
    }
    assert.deepStrictEqual([env.a.seen, env.b.seen, bed.state.secretReads], [[], [], 0]);
    assert.deepStrictEqual(env.audit.map((entry) => [entry.action, entry.details.code]), cases.map(([, code]) => ["vault.use_denied", code]));
});

test("a text body over 256 KB is cut on the limit without leaving the start of the token behind", async (t) => {
    const env = await setup(t);
    const shown = env.text(await env.call({ item: "api", method: "GET", url: `${env.a.base}/big` }));
    assert.strictEqual(shown.slice(shown.indexOf("\n\n") + 2), `${"a".repeat(LIMIT - 5)}\n[truncated after ${LIMIT} bytes]`);
});

test("a session approval for reading does not cover writing: the next GET goes without a card, a POST opens its own with access write", { timeout: 5000 }, async (t) => {
    const env = await setup(t, { approvalRequired: true });
    const ws = { readyState: 1, send: () => {} };
    stateBroadcaster.register(1, "vault-http-window", ws);
    t.after(() => stateBroadcaster.unregister(1, ws));
    const cards = () => approvals.listOpenApprovals(1);
    const get = () => env.call({ item: "api", method: "GET", url: `${env.a.base}/echo` });

    const first = get();
    await until(() => cards().length === 1);
    assert.deepStrictEqual([cards()[0].tool, cards()[0].access, cards()[0].target], ["vault_http", "read", `GET ${env.a.host}/echo`]);
    approvals.answerApproval(cards()[0].id, 1, "session");
    assert.match(env.text(await first), /^HTTP 200\n/);
    assert.match(env.text(await get()), /^HTTP 200\n/, "the session approval covers the next read");

    const post = env.call({ item: "api", method: "POST", url: `${env.a.base}/issues`, body: '{"title":"x"}', headers: { "Content-Type": "application/json" } });
    await until(() => cards().length === 1);
    assert.deepStrictEqual([cards()[0].access, cards()[0].target], ["write", `POST ${env.a.host}/issues`]);
    approvals.answerApproval(cards()[0].id, 1, "once");
    assert.match(env.text(await post), /^HTTP 201\n/);
    assert.deepStrictEqual(env.a.seen.map((request) => request.method), ["GET", "GET", "POST"]);
});

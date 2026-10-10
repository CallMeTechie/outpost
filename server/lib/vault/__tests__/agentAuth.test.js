const test = require("node:test");
const assert = require("node:assert");
const dns = require("node:dns");
const express = require("express");
const { Sequelize } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const vault = { enabled: true };
fake("../../../utils/database", db);
fake("../state", { isVaultEnabled: () => vault.enabled });

const Account = require("../../../models/Account");
const ApiKey = require("../../../models/ApiKey");
const AuditLog = require("../../../models/AuditLog");
const Entry = require("../../../models/Entry");
const Session = require("../../../models/Session");
const { createAuditLog, AUDIT_ACTIONS } = require("../../../controllers/audit");
const { authenticate } = require("../../../middlewares/auth");
const { requireLoginSession } = require("../../../middlewares/requireLoginSession");
const { createSession } = require("../../../controllers/session");
const { createApiKey, generateToken, hashToken } = require("../../../controllers/apiKey");
const ipBinding = require("../ipBinding");

const REVEAL_PATH = "/api/vault/items/1/secrets/password";
const echo = (req, res) => res.json({ accountId: req.user.id, agent: req.agent ?? null });

const app = express();
app.set("trust proxy", true);
app.use("/api/mcp", authenticate, echo);
app.get("/api/vault/agent-keys/probe", authenticate, (req, res) => res.json({ seenIp: req.ip }));
app.use("/api/entries", authenticate, echo);
app.get(REVEAL_PATH, authenticate, requireLoginSession, echo);
app.use("/api/accounts/api-keys", require("../../../routes/apiKey"));
app.post("/api/audited", authenticate, async (req, res) => {
    await createAuditLog({ accountId: req.user.id, action: AUDIT_ACTIONS.VAULT_REVEAL, resource: "vault", details: { item: "nas-admin" } });
    res.json({});
});

const audits = () => AuditLog.findAll({ order: [["id", "ASC"]] });

let server;
let anna;
const servers = {};

const call = async (method, path, token, ip = "192.0.2.10") => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ip },
    });
    return { status: response.status, body: await response.json() };
};

const agentKey = async (entry, values = {}) => {
    const token = generateToken();
    const key = await ApiKey.create({
        accountId: anna.id, name: `claude@${entry.name}`, tokenHash: hashToken(token), prefix: `${token.slice(0, 14)}…`,
        kind: "agent", pending: false, entryId: entry.id, agentType: "claude", ipBinding: true, allowedCidrs: null, ...values,
    });
    return { token, id: key.id };
};

test.before(async () => {
    await db.sync();
    anna = await Account.create({ firstName: "Anna", lastName: "Admin", username: "anna", password: "x" });
    const ssh = (name, ip) => Entry.create({ accountId: anna.id, type: "server", name, config: { ip, protocol: "ssh" } });
    servers.nas = await ssh("nas", "192.0.2.10");
    servers.dockerNas = await ssh("docker-nas", "192.0.2.20");
    servers.named = await ssh("named", "nas.lan");
    servers.handedOver = await ssh("handed-over", "192.0.2.40");
    server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
});

test.after(() => {
    server.closeAllConnections();
    server.close();
});

test.beforeEach(async () => {
    await AuditLog.destroy({ where: {} });
    ipBinding._resetForTests();
});

test("ein endgültiger Agenten-Key erreicht nur /api/mcp, nur bei laufendem Vault und zugänglichem Server; ein Konto-Key weiter alles (Spec-Test 1)", async (t) => {
    t.after(() => { vault.enabled = true; });
    const key = await agentKey(servers.nas);
    const handedOver = await agentKey(servers.handedOver);
    const lastUsedAt = async ({ id }) => (await ApiKey.findByPk(id)).lastUsedAt;

    for (const [method, path] of [["GET", "/api/entries"], ["GET", "/api/vault/agent-keys/probe"], ["GET", REVEAL_PATH]]) {
        const denied = await call(method, path, key.token);
        assert.deepStrictEqual(denied, { status: 403, body: { code: 403, message: "Agent keys can only access the MCP endpoint" } }, path);
    }

    vault.enabled = false;
    assert.deepStrictEqual(await call("POST", "/api/mcp", key.token),
        { status: 401, body: { message: "The provided API key is not valid" } }, "Vault aus: wie ein ungültiger Key");
    vault.enabled = true;

    await Entry.update({ accountId: 999 }, { where: { id: servers.handedOver.id } });
    assert.deepStrictEqual(await call("POST", "/api/mcp", handedOver.token, "192.0.2.40"),
        { status: 403, body: { code: 403, message: "The server of this agent key is no longer accessible" } });
    assert.deepStrictEqual([await lastUsedAt(key), await lastUsedAt(handedOver)], [null, null], "abgewiesene Anfragen setzen lastUsedAt nicht");

    const mcp = await call("POST", "/api/mcp", key.token);
    assert.deepStrictEqual([mcp.status, mcp.body.agent], [200, { keyId: key.id, entryId: servers.nas.id, agentType: "claude" }]);
    assert.notStrictEqual(await lastUsedAt(key), null);

    const accountKey = await createApiKey(anna.id, { name: "cli" });
    assert.strictEqual((await call("GET", "/api/entries", accountKey.token)).status, 200);
});

test("ein pending-Key passiert nur probe, dort ohne IP-Bindung (Spec-Test 1, Einrichtung 1a)", async () => {
    const key = await agentKey(servers.nas, { pending: true });

    const probe = await call("GET", "/api/vault/agent-keys/probe", key.token, "172.17.0.1");
    assert.deepStrictEqual([probe.status, probe.body], [200, { seenIp: "172.17.0.1" }]);

    assert.strictEqual((await call("POST", "/api/mcp", key.token)).status, 401);
    assert.strictEqual((await call("GET", "/api/entries", key.token)).status, 401);
    assert.strictEqual(await AuditLog.count(), 0);
});

test("die IP-Bindung lässt eigene Adressen, eingetragene Bereiche und gelöste Bindungen zu (Spec-Test 2)", async (t) => {
    const lookups = [];
    t.mock.method(dns.promises, "lookup", async (host, options) => {
        lookups.push([host, options]);
        return [{ address: "192.0.2.30", family: 4 }, { address: "2001:db8::30", family: 6 }];
    });

    const cases = [
        ["eigene Adresse, IP im Server-Eintrag", await agentKey(servers.nas), "192.0.2.10"],
        ["Hostname, A-Eintrag", await agentKey(servers.named), "192.0.2.30"],
        ["Hostname, AAAA-Eintrag", await agentKey(servers.named), "2001:db8::30"],
        ["zusätzlicher IPv4-Bereich", await agentKey(servers.nas, { allowedCidrs: ["198.51.100.0/24"] }), "198.51.100.7"],
        ["zusätzlicher IPv6-Bereich", await agentKey(servers.nas, { allowedCidrs: ["2001:db8:1::/64"] }), "2001:db8:1::5"],
        ["IP-Bindung aus", await agentKey(servers.nas, { ipBinding: false }), "203.0.113.9"],
    ];
    for (const [label, key, ip] of cases)
        assert.strictEqual((await call("POST", "/api/mcp", key.token, ip)).status, 200, label);

    assert.deepStrictEqual(lookups, [["nas.lan", { all: true }]], "eine Auflösung je Host innerhalb von 60 s");
    assert.strictEqual(await AuditLog.count(), 0);
});

test("fremde Adresse: 403 und ein Audit je Key und Adresse; die übernommene Gateway-Adresse gilt (Spec-Test 2, Review Focus 3)", async () => {
    const key = await agentKey(servers.dockerNas);

    for (let attempt = 0; attempt < 2; attempt++) {
        const denied = await call("POST", "/api/mcp", key.token, "172.17.0.1");
        assert.deepStrictEqual(denied, { status: 403, body: { code: 403, message: "This agent key is not allowed from this address" } });
    }
    assert.strictEqual((await call("POST", "/api/mcp", key.token, "172.17.0.2")).status, 403);

    assert.deepStrictEqual((await audits()).map((audit) => [audit.action, audit.accountId, audit.details.keyId, audit.details.ip]), [
        ["vault.agent_ip_denied", anna.id, key.id, "172.17.0.1"],
        ["vault.agent_ip_denied", anna.id, key.id, "172.17.0.2"],
    ]);

    await ApiKey.update({ allowedCidrs: ["172.17.0.1/32"] }, { where: { id: key.id } });
    assert.strictEqual((await call("POST", "/api/mcp", key.token, "172.17.0.1")).status, 200);
});

test("requireLoginSession weist Impersonation und Konto-Keys ab; Audits der Impersonation nennen den Impersonator", async () => {
    const ben = await Account.create({ firstName: "Ben", lastName: "User", username: "ben", password: "x" });
    const own = await Session.create({ accountId: ben.id, ip: "192.0.2.50", userAgent: "test" });
    const impersonated = await createSession(ben.id, "test", { impersonatorId: anna.id });
    const accountKey = await createApiKey(ben.id, { name: "cli" });

    assert.strictEqual((await call("GET", REVEAL_PATH, own.token)).status, 200);
    assert.deepStrictEqual(await call("GET", REVEAL_PATH, impersonated.token),
        { status: 403, body: { code: 403, message: "This action requires a signed-in session" } });
    assert.strictEqual((await call("GET", REVEAL_PATH, accountKey.token)).status, 403);

    assert.deepStrictEqual(await call("POST", "/api/accounts/api-keys", impersonated.token),
        { status: 403, body: { code: 403, message: "This action requires a signed-in session" } });
    assert.deepStrictEqual(await call("POST", "/api/accounts/api-keys", own.token),
        { status: 400, body: { message: "A name is required" } }, "eigene Sitzung passiert den Wächter");

    for (const token of [impersonated.token, own.token])
        assert.strictEqual((await call("POST", "/api/audited", token)).status, 200);
    assert.deepStrictEqual((await audits()).map((audit) => audit.details), [
        { item: "nas-admin", impersonatorId: anna.id },
        { item: "nas-admin" },
    ]);
});

process.env.VAULT_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { Sequelize } = require("sequelize");

// Foreign keys off: the fixtures create api_keys rows without the accounts/entries graph behind them.
const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const ENTRY_ID = 5;
const ACCOUNT_A = 1;
const ACCOUNT_B = 2;
const audits = [];
const execs = [];
const SERVER_IP = "198.51.100.7";
const RESET = { cliFound: true, setupFails: false, registered: "ABSENT", revokeOutput: "REMOVED\n", probeFrom: SERVER_IP };
const dropped = {};
const files = [];
const state = { base: null, identityOf: {}, ...RESET };

fake("../../../utils/database", db);
fake("../../../controllers/audit", {
    createAuditLog: async (entry) => { audits.push(entry); },
    AUDIT_ACTIONS: {
        VAULT_AGENT_KEY_CREATE: "vault.agent_key_create",
        VAULT_AGENT_KEY_REVOKE: "vault.agent_key_revoke",
        VAULT_AGENT_IP_DENIED: "vault.agent_ip_denied",
    },
    RESOURCE_TYPES: { VAULT: "vault" },
});
fake("../../../permissions/engine", {
    getSystemPermissions: async () => ({ isAdmin: false, permissions: ["vault.use"] }),
    getOrganizationPermissions: async () => ({ isOwner: false, isAdmin: false, permissions: [] }),
});
fake("../../../controllers/entry", {
    validateEntryAccess: async (accountId, entry) => ([ACCOUNT_A, ACCOUNT_B].includes(accountId)
        ? { valid: true, entry } : { code: 403, message: "no" }),
    resolveEntryScope: async (entry) => ({ organizationId: entry.organizationId ?? null, ownerAccountId: entry.accountId }),
});
fake("../../../controllers/identity", { getIdentityCredentials: async () => ({ password: "pw" }) });
fake("../../ConnectionService", {
    buildSSHParams: (identity) => ({ username: identity.username }),
    resolveJumpHosts: async () => [],
});
fake("../../../utils/identityResolver", {
    resolveIdentity: async (entry, identityId, direct, accountId) => {
        const id = identityId ?? state.identityOf[accountId];
        return (id && (await Identity.findByPk(id))) || { identity: null, requiresIdentity: true };
    },
});
// Plays the remote server: the probe really calls Outpost back with the key from the command line,
// through a proxy that reports probeFrom (null: the probe arrives from the browser's own address).
fake("../../controlPlane/ControlPlaneServer", {
    hasEngine: () => true,
    execCommand: async (host, port, params, command, jumpHosts, engineId) => {
        execs.push({ host, username: params.username, command, engineId });
        const ok = (stdout) => ({ success: true, stdout, stderr: "", exitCode: 0 });
        if (command.includes("chmod 700")) {
            const [token] = /outpost_[0-9a-f]{64}/.exec(command);
            const [file] = /key-\d+-[0-9a-f]{16}/.exec(command);
            dropped[file] = token;
            files.push(["drop", file]);
            return ok("");
        }
        if (command.includes('rm -f "$HOME/.config/outpost/key-')) {
            files.push(["cleanup", /key-\d+-[0-9a-f]{16}/.exec(command)[0]]);
            return ok("");
        }
        if (command.includes("/api/vault/agent-keys/probe")) {
            const token = dropped[/key-\d+-[0-9a-f]{16}/.exec(command)[0]];
            const res = await fetch(`${state.base}/api/vault/agent-keys/probe`, {
                headers: { authorization: `Bearer ${token}`, ...(state.probeFrom ? { "x-forwarded-for": state.probeFrom } : {}) },
            });
            return { success: true, stdout: await res.text(), stderr: "", exitCode: res.ok ? 0 : 22 };
        }
        if (command.includes("mcp add")) {
            if (state.setupFails) throw new Error("exec timed out");
            return ok("OUTPOST_REPLACED=1\n");
        }
        if (command.includes("echo FOREIGN")) return ok(state.revokeOutput);
        if (command.includes("MATCH|OTHER")) return ok(`${state.registered}\n`);
        if (command.includes("command -v")) return state.cliFound ? ok("/home/deploy/.local/bin/claude\n") : { success: true, stdout: "", stderr: "", exitCode: 1 };
        throw new Error(`unexpected command ${command}`);
    },
});

const ApiKey = require("../../../models/ApiKey");
const Account = require("../../../models/Account");
const Session = require("../../../models/Session");
const Entry = require("../../../models/Entry");
const Identity = require("../../../models/Identity");
const VaultSettings = require("../../../models/VaultSettings");
const { createApiKey } = require("../../../controllers/apiKey");
const { initVaultState } = require("../state");
const { authenticate } = require("../../../middlewares/auth");
const { sweepPending } = require("../../../controllers/agentKeys");
const router = require("../../../routes/vault/agentKeys");

const tokens = {};

test.before(async () => {
    await db.sync();
    await initVaultState();
    await (await VaultSettings.getOrCreate()).update({ agentUrl: "https://outpost.example/" });
    for (const id of [ACCOUNT_A, ACCOUNT_B])
        await Account.create({ id, firstName: "F", lastName: "L", username: `user${id}`, password: "x" });
    await Entry.create({ id: ENTRY_ID, accountId: ACCOUNT_A, type: "server", name: "web01", config: { protocol: "ssh", ip: "192.0.2.10", engineId: "engine-7" } });
    for (const [id, accountId] of [[11, ACCOUNT_A], [12, ACCOUNT_B]]) {
        await Identity.create({ id, accountId, name: `deploy-${accountId}`, type: "password", username: "deploy" });
        state.identityOf[accountId] = id;
    }
    tokens.a = (await Session.create({ accountId: ACCOUNT_A, ip: "x", userAgent: "t" })).token;
    tokens.b = (await Session.create({ accountId: ACCOUNT_B, ip: "x", userAgent: "t" })).token;
    tokens.impersonated = (await Session.create({ accountId: ACCOUNT_A, ip: "x", userAgent: "t", impersonatorId: ACCOUNT_B })).token;
    tokens.accountKey = (await createApiKey(ACCOUNT_A, { name: "ci" })).token;
});

test.beforeEach(async () => {
    execs.length = 0;
    files.length = 0;
    audits.length = 0;
    Object.assign(state, RESET);
    await ApiKey.destroy({ where: { kind: "agent" } });
});

const listen = async (t) => {
    const app = express();
    app.set("trust proxy", "loopback");
    app.use(express.json());
    app.use("/api/vault", router);
    app.post("/api/mcp", authenticate, (req, res) => res.json({ keyId: req.agent?.keyId ?? null }));
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    state.base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => { server.closeAllConnections(); server.close(); });
};

const call = async (method, path, token, body, headers = {}) => {
    const res = await fetch(`${state.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};

const setUp = async (token = tokens.a, body = {}) => call("POST", "/api/vault/agent-keys", token, { entryId: ENTRY_ID, agentTypes: ["claude"], ...body });
const keyFrom = (command) => /outpost_[0-9a-f]{64}/.exec(command)[0];
const PROBE = "/api/vault/agent-keys/probe";

test("Review Focus 3: probe misst die Adresse des pending-Keys, confirm übernimmt sie einmal, danach gilt der Key", async (t) => {
    await listen(t);

    const { status, body } = await setUp();

    assert.strictEqual(status, 201);
    const [result] = body.results;
    assert.deepStrictEqual(
        { agentType: result.agentType, status: result.status, reason: result.reason, remoteUser: result.remoteUser, probe: result.probe, replacedRegistration: result.replacedRegistration, command: result.command },
        { agentType: "claude", status: "configured", reason: null, remoteUser: "deploy", probe: { seenIp: SERVER_IP, matches: false }, replacedRegistration: true, command: undefined },
    );
    assert.ok(execs.every((exec) => exec.engineId === "engine-7" && exec.host === "192.0.2.10" && exec.username === "deploy"));
    const key = keyFrom(execs[0].command);
    assert.deepStrictEqual(execs.filter((exec) => exec.command.includes(key)).length, 1);

    assert.strictEqual((await call("GET", PROBE, key)).status, 403);
    assert.strictEqual((await call("GET", PROBE, tokens.a)).status, 403);
    assert.strictEqual((await call("GET", PROBE, tokens.accountKey)).status, 403);

    const fromServer = { "x-forwarded-for": SERVER_IP };
    assert.strictEqual((await call("POST", "/api/mcp", key, undefined, fromServer)).status, 403);
    assert.deepStrictEqual((await call("POST", `/api/vault/agent-keys/${result.id}/confirm`, tokens.a, { addSeenIp: true })).body, { success: true });
    assert.deepStrictEqual(await call("POST", "/api/mcp", key, undefined, fromServer), { status: 200, body: { keyId: result.id } });
    assert.strictEqual((await call("POST", `/api/vault/agent-keys/${result.id}/confirm`, tokens.a, { addSeenIp: true })).status, 409);
    assert.deepStrictEqual((await ApiKey.findByPk(result.id)).allowedCidrs, [`${SERVER_IP}/32`]);
});

test("nach 15 Minuten lässt sich die gemessene Adresse nicht mehr übernehmen und ein pending-Key nicht mehr bestätigen", async (t) => {
    await listen(t);
    const [{ id }] = (await setUp()).body.results;
    state.cliFound = false;
    const [pending] = (await setUp()).body.results;
    await db.query("UPDATE api_keys SET createdAt = :at WHERE id IN (:ids)",
        { replacements: { at: new Date(Date.now() - 16 * 60 * 1000).toISOString(), ids: [id, pending.id] } });

    assert.strictEqual((await call("POST", `/api/vault/agent-keys/${id}/confirm`, tokens.a, { addSeenIp: true })).status, 409);
    assert.strictEqual((await ApiKey.findByPk(id)).allowedCidrs, null);
    assert.strictEqual((await call("POST", `/api/vault/agent-keys/${pending.id}/confirm`, tokens.a, {})).status, 410);
    assert.strictEqual((await ApiKey.findByPk(pending.id)).pending, true);
});

test("scheitert die Einrichtung, kommt der Befehl zum Kopieren und der Key bleibt pending bis zur Bestätigung, außer die Registrierung steht trotz Exec-Fehler", async (t) => {
    await listen(t);
    state.cliFound = false;

    const [result] = (await setUp()).body.results;

    assert.deepStrictEqual([result.status, result.reason], ["manual", "cli_missing"]);
    const key = keyFrom(result.command);
    assert.match(result.command, /mcp add --scope user --transport http outpost/);
    assert.ok(result.command.startsWith(" "), "a leading space keeps the command out of the bash history");
    assert.strictEqual(files.length, 2);
    assert.deepStrictEqual(files.map(([op]) => op), ["drop", "cleanup"]);
    assert.strictEqual(files[0][1], files[1][1]);
    assert.deepStrictEqual((await call("GET", `/api/vault/agent-keys?entryId=${ENTRY_ID}`, tokens.a)).body.keys, []);
    assert.strictEqual((await call("POST", "/api/mcp", key)).status, 401);

    assert.deepStrictEqual((await call("POST", `/api/vault/agent-keys/${result.id}/confirm`, tokens.a, {})).body, { success: true });
    assert.deepStrictEqual((await call("GET", `/api/vault/agent-keys?entryId=${ENTRY_ID}`, tokens.a)).body.keys.map((k) => k.id), [result.id]);

    Object.assign(state, { cliFound: true, setupFails: true, registered: "MATCH" });
    const [recovered] = (await setUp()).body.results;
    assert.deepStrictEqual([recovered.status, recovered.reason, recovered.command], ["configured", null, undefined]);
    assert.ok(execs.some((exec) => /MATCH\|OTHER/.test(exec.command)));
    state.registered = "OTHER";
    const [failed] = (await setUp()).body.results;
    assert.deepStrictEqual([failed.status, failed.reason, (await ApiKey.findByPk(failed.id)).pending], ["manual", "exec_failed", true]);
});

test("sweepPending löscht nur pending-Keys, die älter als 15 Minuten sind", async (t) => {
    await listen(t);
    const [configured] = (await setUp()).body.results;
    state.cliFound = false;
    const [pending] = (await setUp()).body.results;

    assert.strictEqual(await sweepPending(Date.now() + 14 * 60 * 1000), 0);
    assert.strictEqual(await sweepPending(Date.now() + 16 * 60 * 1000), 1);
    assert.strictEqual(await ApiKey.findByPk(pending.id), null);
    assert.ok(await ApiKey.findByPk(configured.id));
});

test("erneutes Einrichten ersetzt den eigenen alten Key ohne Entfernbefehle, eine gleichzeitige Einrichtung bekommt 409, ein anderes Konto sieht die Warnung", async (t) => {
    await listen(t);
    const [first] = (await setUp()).body.results;
    const [second] = (await setUp()).body.results;

    assert.strictEqual(await ApiKey.findByPk(first.id), null);
    assert.ok(!execs.some((exec) => exec.command.includes("echo FOREIGN")));
    const revokes = audits.filter((audit) => audit.action === "vault.agent_key_revoke");
    assert.deepStrictEqual(revokes.map((audit) => [audit.details.keyId, audit.details.registration]), [[first.id, "replaced"]]);
    const own = (await call("GET", `/api/vault/agent-keys?entryId=${ENTRY_ID}`, tokens.a)).body;
    assert.deepStrictEqual([own.keys.map((k) => k.id), own.remoteUser, own.otherAccountConfigured], [[second.id], "deploy", false]);
    const other = (await call("GET", `/api/vault/agent-keys?entryId=${ENTRY_ID}`, tokens.b)).body;
    assert.deepStrictEqual(other, { keys: [], remoteUser: "deploy", otherAccountConfigured: true });

    const parallel = await Promise.all([setUp(), setUp()]);
    assert.deepStrictEqual(parallel.map((res) => res.status).sort(), [201, 409]);
});

test("Spec-Test 11: Einrichten, Bestätigen und Entziehen antworten in Impersonation und mit Konto-Key mit 403", async (t) => {
    await listen(t);
    const [{ id }] = (await setUp()).body.results;
    execs.length = 0;

    for (const token of [tokens.impersonated, tokens.accountKey]) {
        assert.strictEqual((await setUp(token)).status, 403);
        assert.strictEqual((await call("POST", `/api/vault/agent-keys/${id}/confirm`, token, { addSeenIp: true })).status, 403);
        assert.strictEqual((await call("DELETE", `/api/vault/agent-keys/${id}`, token)).status, 403);
    }
    assert.strictEqual((await call("POST", `/api/vault/agent-keys/${id}/confirm`, tokens.b, {})).status, 404);
    assert.strictEqual((await call("DELETE", `/api/vault/agent-keys/${id}`, tokens.b)).status, 404);
    assert.deepStrictEqual(execs, []);
    assert.strictEqual(await ApiKey.count({ where: { kind: "agent" } }), 1);
});

test("zusätzliche Adressbereiche werden geprüft und eine einzelne Adresse wird zu /32 bzw. /128", async (t) => {
    await listen(t);

    for (const allowedCidrs of [["10.0.0.0/33"], ["web01"], ["10.0.0.1/8/1"]])
        assert.strictEqual((await setUp(tokens.a, { allowedCidrs })).status, 400, JSON.stringify(allowedCidrs));
    const [{ id }] = (await setUp(tokens.a, { allowedCidrs: ["10.1.2.3", "2001:db8::/32"] })).body.results;

    assert.deepStrictEqual((await ApiKey.findByPk(id)).allowedCidrs, ["10.1.2.3/32", "2001:db8::/32"]);
});

// Account B: the per-account limiter of account A (30 per minute) spans the whole file.
test("die Probe zählt nur die erste Messung, und die Adresse des bestätigenden Browsers lässt sich nicht übernehmen", async (t) => {
    await listen(t);
    state.cliFound = false;
    state.probeFrom = null;
    const [result] = (await setUp(tokens.b)).body.results;
    const confirmPath = `/api/vault/agent-keys/${result.id}/confirm`;

    assert.deepStrictEqual(result.probe, { seenIp: "127.0.0.1", matches: false });
    const again = await call("GET", PROBE, keyFrom(result.command), undefined, { "x-forwarded-for": "203.0.113.9" });
    assert.deepStrictEqual(again, { status: 200, body: { seenIp: "203.0.113.9" } });
    assert.strictEqual((await ApiKey.findByPk(result.id)).seenIp, "127.0.0.1");

    assert.deepStrictEqual((await call("POST", confirmPath, tokens.b, { addSeenIp: true })).body, {
        code: 409, message: "The measured address is the address of your browser; Outpost sees a proxy, not the server",
    });
    assert.deepStrictEqual((await call("POST", confirmPath, tokens.b, {})).body, { success: true });
    assert.deepStrictEqual((await ApiKey.findByPk(result.id)).allowedCidrs, null);
});

test("Entziehen läuft mit der gespeicherten Identität; ist sie gelöscht, kommt der Entfernbefehl zum Kopieren", async (t) => {
    await listen(t);
    const [first] = (await setUp()).body.results;
    state.revokeOutput = "FOREIGN\n";
    execs.length = 0;

    assert.deepStrictEqual((await call("DELETE", `/api/vault/agent-keys/${first.id}`, tokens.a)).body, { success: true, registration: "foreign" });
    assert.deepStrictEqual(execs.map((exec) => [exec.username, exec.engineId]), [["deploy", "engine-7"]]);
    assert.strictEqual(await ApiKey.findByPk(first.id), null);
    assert.deepStrictEqual([audits.at(-1).action, audits.at(-1).resourceId, audits.at(-1).details.keyId], ["vault.agent_key_revoke", null, first.id]);

    const [second] = (await setUp()).body.results;
    t.after(() => Identity.create({ id: 11, accountId: ACCOUNT_A, name: "deploy-1", type: "password", username: "deploy" }));
    await Identity.destroy({ where: { id: 11 } });
    execs.length = 0;
    const revoked = (await call("DELETE", `/api/vault/agent-keys/${second.id}`, tokens.a)).body;

    assert.deepStrictEqual([revoked.registration, execs.length], ["unknown", 0]);
    assert.match(revoked.commands, /mcp remove --scope user outpost/);
    assert.strictEqual(await ApiKey.findByPk(second.id), null);
});

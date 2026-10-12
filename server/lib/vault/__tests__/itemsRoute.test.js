process.env.ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
process.env.VAULT_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { Sequelize } = require("sequelize");

// foreignKeys: false - the vault models reference accounts and organizations; this test creates no accounts.
const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// 1: vault.use, active member of 20 without org rights. 3: active member of 20 with vault.reveal and
// vault.manage, settings.vault. 4: vault.use, only invited to 20 - the engine would grant org rights,
// the membership must not.
const SYSTEM = { 1: ["vault.use"], 3: ["settings.vault"], 4: ["vault.use"] };
const ORG = { "3:20": ["vault.reveal", "vault.manage"], "4:20": ["vault.reveal", "vault.manage"] };
const CALLERS = {
    "s-owner": { user: { id: 1 }, session: { id: 11, accountId: 1, impersonatorId: null } },
    "s-imp": { user: { id: 1 }, session: { id: 12, accountId: 1, impersonatorId: 99 } },
    "k-owner": { user: { id: 1 }, apiKey: { id: 5, kind: "account" } },
    "s-revealer": { user: { id: 3 }, session: { id: 13, accountId: 3, impersonatorId: null } },
    "s-invited": { user: { id: 4 }, session: { id: 14, accountId: 4, impersonatorId: null } },
};
const SYSTEM_DEFAULT = structuredClone(SYSTEM);
const ORG_DEFAULT = structuredClone(ORG);
const resetTo = (target, defaults) => {
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, structuredClone(defaults));
};

fake("../../../utils/database", db);
fake("../../../permissions/engine", {
    getSystemPermissions: async (accountId) => ({ isAdmin: false, permissions: SYSTEM[accountId] ?? [] }),
    getOrganizationPermissions: async (accountId, organizationId) =>
        ({ isOwner: false, isAdmin: false, permissions: ORG[`${accountId}:${organizationId}`] ?? [] }),
    hasSystemPermission: async (accountId, permission) => (SYSTEM[accountId] ?? []).includes(permission),
    hasOrganizationPermission: async (accountId, organizationId, permission) =>
        (ORG[`${accountId}:${organizationId}`] ?? []).includes(permission),
});
fake("../../../middlewares/auth", {
    authenticate: (req, res, next) => {
        const caller = CALLERS[(req.header("authorization") ?? "").replace(/^Bearer /, "")];
        if (!caller) return res.status(401).json({ message: "The provided token is not valid" });
        Object.assign(req, caller);
        next();
    },
});

const audits = [];
const audit = require("../../../controllers/audit");
audit.createAuditLog = async (entry) => { audits.push(entry); };

const state = require("../state");
const { writeSecret, readSecret } = require("../secrets");
const VaultItem = require("../../../models/VaultItem");
const VaultSecret = require("../../../models/VaultSecret");
const Organization = require("../../../models/Organization");
const OrganizationMember = require("../../../models/OrganizationMember");
const Entry = require("../../../models/Entry");
const Account = require("../../../models/Account");
const { pinKey, pinnedKey } = require("../sshTargets");
const { deleteEntry } = require("../../../controllers/entry");
const itemsRouter = require("../../../routes/vault/items");
const settingsRouter = require("../../../routes/vault/settings");

let personal;
let shared;

test.before(async () => {
    await db.sync();
    await state.initVaultState();
    await Organization.create({ id: 20, name: "Ops" });
    await OrganizationMember.bulkCreate([
        { organizationId: 20, accountId: 1, role: "member", status: "active", invitedBy: 3 },
        { organizationId: 20, accountId: 3, role: "member", status: "active", invitedBy: 3 },
        { organizationId: 20, accountId: 4, role: "member", status: "pending", invitedBy: 3 },
    ]);
    personal = await VaultItem.create({
        accountId: 1, name: "portal-login", type: "login",
        fields: { username: "ma", origins: ["https://portal.example.com"] }, approvalRequired: true, allServers: false, createdBy: 1,
    });
    await writeSecret(personal.id, "password", "hunter2-personal");
    shared = await VaultItem.create({
        organizationId: 20, name: "backup-db", type: "database",
        fields: { engine: "postgres", host: "db.internal", port: 5432, database: "backup", username: "backup" },
        approvalRequired: true, allServers: false, createdBy: 3,
    });
    await writeSecret(shared.id, "password", "hunter2-shared");
});

test.beforeEach(() => {
    audits.length = 0;
    resetTo(SYSTEM, SYSTEM_DEFAULT);
    resetTo(ORG, ORG_DEFAULT);
});

const listen = async (t, { trustProxy = false } = {}) => {
    const app = express();
    app.set("trust proxy", trustProxy);
    app.use(express.json());
    app.use("/api/vault", itemsRouter);
    app.use("/api/vault", settingsRouter);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    t.after(() => server.close());
    const call = (method) => async (path, token, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/vault${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, text, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
    };
    return { get: call("GET"), post: call("POST"), patch: call("PATCH"), del: call("DELETE") };
};

test("Reveal: Besitzer persönlich und vault.reveal in der Organisation ja, Mitglied ohne Recht 403, fremder Mandant 404, unlesbarer Wert 422; jeder Abruf auditiert", async (t) => {
    const { get } = await listen(t);
    const reveal = (token, item, field = "password") => get(`/items/${item.id}/secrets/${field}`, token);

    assert.deepStrictEqual((await reveal("s-owner", personal)).body, { value: "hunter2-personal" });
    assert.deepStrictEqual((await reveal("s-revealer", shared)).body, { value: "hunter2-shared" });
    assert.strictEqual((await reveal("s-owner", shared)).status, 403);
    assert.strictEqual((await reveal("s-invited", shared)).status, 404);
    assert.strictEqual((await reveal("s-revealer", personal)).status, 404);
    assert.strictEqual((await reveal("s-owner", personal, "token")).status, 404);

    assert.deepStrictEqual(
        audits.map((a) => [a.action, a.accountId, a.organizationId, a.resourceId, a.details.item, a.details.field]),
        [
            ["vault.reveal", 1, null, personal.id, "portal-login", "password"],
            ["vault.reveal", 3, 20, shared.id, "org:20/backup-db", "password"],
        ],
    );
    assert.doesNotMatch(JSON.stringify(audits), /hunter2/);

    audits.length = 0;
    const { valueEncrypted, valueIV, valueAuthTag } = await VaultSecret.findOne({ where: { itemId: personal.id, field: "password" } });
    await VaultSecret.update({ valueEncrypted, valueIV, valueAuthTag }, { where: { itemId: shared.id, field: "password" } });
    const unreadable = await reveal("s-revealer", shared);
    assert.deepStrictEqual([unreadable.status, unreadable.body.code], [422, 422]);
    const unreadableFlag = async () => (await get("/items", "s-revealer")).body.items.find((item) => item.id === shared.id).unreadable;
    assert.strictEqual(await unreadableFlag(), true);
    await writeSecret(shared.id, "password", "hunter2-shared");
    assert.strictEqual(await unreadableFlag(), false);
    assert.deepStrictEqual(audits.map((a) => [a.action, a.details.item, a.details.field]), [["vault.item_unreadable", "org:20/backup-db", "password"]]);
    assert.doesNotMatch(unreadable.text + JSON.stringify(audits), /hunter2/);
});

test("Reveal und das Abschalten der Freigabe verlangen eine Login-Session ohne Impersonation: Impersonation und Konto-Key bekommen 403, ohne Audit", async (t) => {
    const { get, post, patch } = await listen(t);
    const APPROVAL_OFF = "Turning off approvals requires a signed-in session";

    for (const token of ["s-imp", "k-owner"]) {
        const { status, text } = await get(`/items/${personal.id}/secrets/password`, token);
        assert.strictEqual(status, 403, token);
        assert.doesNotMatch(text, /hunter2/);

        const created = await post("/items", token, { name: "no-approval", type: "generic", secrets: { value: "x" }, approvalRequired: false });
        const patched = await patch(`/items/${personal.id}`, token, { approvalRequired: false });
        assert.deepStrictEqual([created.status, created.body.message, patched.status, patched.body.message], [403, APPROVAL_OFF, 403, APPROVAL_OFF], token);
    }
    assert.deepStrictEqual(audits, []);
    assert.strictEqual(await VaultItem.count({ where: { name: "no-approval" } }), 0);
    const listed = (await get("/items", "s-imp")).body.items.find((item) => item.id === personal.id);
    assert.deepStrictEqual([listed.canManage, listed.canReveal, listed.approvalRequired], [true, false, true]);

    const fromSession = await patch(`/items/${personal.id}`, "s-owner", { approvalRequired: false });
    assert.deepStrictEqual([fromSession.status, fromSession.body.item.approvalRequired], [200, false]);
    const alreadyOff = await patch(`/items/${personal.id}`, "s-imp", { description: "edited while impersonating", approvalRequired: false });
    assert.deepStrictEqual([alreadyOff.status, alreadyOff.body.item.description, alreadyOff.body.item.approvalRequired], [200, "edited while impersonating", false]);
    assert.strictEqual((await patch(`/items/${personal.id}`, "s-owner", { approvalRequired: true, description: "" })).body.item.approvalRequired, true);
});

test("PATCH mit geändertem Ursprung löscht die gespeicherten Werte im selben Vorgang; dieselbe Adresse anders geschrieben nicht; Listen tragen nie Werte", async (t) => {
    const { get, post, patch } = await listen(t);
    const created = await post("/items", "s-owner", {
        name: "shop-login", type: "login", fields: { username: "ma", origins: ["https://shop.example.com"] }, secrets: { password: "pw-one" },
    });
    assert.strictEqual(created.status, 201);
    const { item } = created.body;
    assert.deepStrictEqual([item.ref, item.secretFields, item.approvalRequired, item.canManage, item.canReveal], ["shop-login", ["password"], true, true, true]);

    const sameOrigin = await patch(`/items/${item.id}`, "s-owner", { fields: { username: "ma.backes", origins: ["HTTPS://Shop.Example.com:443"] } });
    assert.deepStrictEqual(
        [sameOrigin.body.secretsCleared, sameOrigin.body.item.secretFields, sameOrigin.body.item.fields],
        [false, ["password"], { username: "ma.backes", origins: ["https://shop.example.com"] }],
    );

    const moved = await patch(`/items/${item.id}`, "s-owner", { fields: { username: "ma.backes", origins: ["https://shop.example.net"] } });
    assert.deepStrictEqual([moved.status, moved.body.secretsCleared, moved.body.item.secretFields], [200, true, []]);
    assert.strictEqual(await readSecret(item.id, "password"), null);
    assert.strictEqual(audits.at(-1).action, "vault.item_update");
    assert.strictEqual(audits.at(-1).details.secretsCleared, true);

    const movedWithValue = await patch(`/items/${item.id}`, "s-owner", {
        fields: { username: "ma.backes", origins: ["https://login.example.net"] }, secrets: { password: "pw-two" },
    });
    assert.deepStrictEqual([movedWithValue.body.secretsCleared, movedWithValue.body.item.secretFields], [true, ["password"]]);
    assert.strictEqual(await readSecret(item.id, "password"), "pw-two");
    const STAMP = "2026-01-01 00:00:00.000 +00:00";
    await db.query(`UPDATE ${VaultItem.getTableName()} SET updatedAt = ? WHERE id = ?`, { replacements: [STAMP, item.id] });
    await patch(`/items/${item.id}`, "s-owner", { secrets: { password: "pw-three" } });
    const { updatedAt } = await VaultItem.findByPk(item.id);
    assert.ok(typeof updatedAt === "string" && new Date(updatedAt) > new Date(STAMP), "a new value ends grants stamped with the old updatedAt");

    for (const [type, secret, fields] of [
        ["api_key", "token", { hosts: ["api.example.com"] }],
        ["generic", "value", {}],
    ]) {
        const fillable = await post("/items", "s-owner", {
            name: `fill-${type.replace("_", "-")}`, type,
            fields: { ...fields, fillOrigins: ["https://app.example.com", "https://docs.example.com"] }, secrets: { [secret]: "tok-one" },
        });
        const reordered = await patch(`/items/${fillable.body.item.id}`, "s-owner", {
            fields: { ...fields, fillOrigins: ["https://docs.example.com", "https://app.example.com"] },
        });
        assert.deepStrictEqual([reordered.body.secretsCleared, reordered.body.item.secretFields], [false, [secret]], type);
        const redirected = await patch(`/items/${fillable.body.item.id}`, "s-owner", {
            fields: { ...fields, fillOrigins: ["https://app.example.com", "https://attacker.example"] },
        });
        assert.deepStrictEqual([redirected.status, redirected.body.secretsCleared, redirected.body.item.secretFields], [200, true, []], type);
        assert.strictEqual(await readSecret(fillable.body.item.id, secret), null, type);
    }

    const list = await get("/items", "s-owner");
    assert.deepStrictEqual(list.body.items.map((entry) => entry.ref).sort(), ["fill-api-key", "fill-generic", "org:20/backup-db", "portal-login", "shop-login"]);
    assert.doesNotMatch(list.text + JSON.stringify(audits), /pw-one|pw-two|pw-three|hunter2|tok-one/);
});

test("PATCH, dessen Speichern scheitert, verliert keine Werte: Name zwischen Prüfung und Schreiben vergeben, Ziel geändert → 409, Wert und Felder wie vorher", async (t) => {
    const { post, patch } = await listen(t);
    const fields = { username: "ma", origins: ["https://bank.example.com"] };
    const { item } = (await post("/items", "s-owner", { name: "bank-login", type: "login", fields, secrets: { password: "pw-bank" } })).body;
    // Another request takes the name after nameTaken has looked.
    VaultItem.addHook("beforeBulkUpdate", "takeName", async (options) => {
        await VaultItem.create({
            accountId: 1, name: "bank-renamed", type: "login", fields, approvalRequired: true, allServers: false, createdBy: 1,
        }, { transaction: options.transaction });
    });
    t.after(() => VaultItem.removeHook("beforeBulkUpdate", "takeName"));

    const failed = await patch(`/items/${item.id}`, "s-owner", {
        name: "bank-renamed", fields: { username: "ma.backes", origins: ["https://bank.example.net"] }, secrets: { password: "pw-new" },
    });
    VaultItem.removeHook("beforeBulkUpdate", "takeName");

    assert.strictEqual(failed.status, 409);
    assert.strictEqual(await readSecret(item.id, "password"), "pw-bank");
    const stored = await VaultItem.findByPk(item.id);
    assert.deepStrictEqual([stored.name, typeof stored.fields === "string" ? JSON.parse(stored.fields) : stored.fields], ["bank-login", fields]);
    assert.ok(!audits.some((entry) => entry.action === "vault.item_update"));
});

test("Einstellungen speichern Agenten-Adresse, IP-Bindung und fillAnywhere; available meldet Schalter, Rechte, Agenten-Adresse, Standard der IP-Bindung, Impersonation und TRUST_PROXY=true; bei ausgeschaltetem Vault sind alle Rechte leer", async (t) => {
    const { get, patch } = await listen(t, { trustProxy: true });

    assert.strictEqual((await patch("/settings", "s-owner", { agentUrl: "https://outpost.example.com" })).status, 403);
    assert.deepStrictEqual((await patch("/settings", "s-revealer", { agentUrl: "https://outpost.example.com/", ipBindingDefault: false })).body,
        { keyStatus: "active", agentUrl: "https://outpost.example.com", ipBindingDefault: false, fillAnywhere: false, trustProxyUnsafe: true });
    assert.strictEqual((await patch("/settings", "s-revealer", {})).status, 400);
    assert.strictEqual((await patch("/settings", "s-revealer", { fillAnywhere: true })).body.fillAnywhere, true);
    assert.deepStrictEqual((await get("/settings", "s-revealer")).body,
        { keyStatus: "active", agentUrl: "https://outpost.example.com", ipBindingDefault: false, fillAnywhere: true, trustProxyUnsafe: true });
    const urlFields = { agentUrl: "https://outpost.example.com", ipBindingDefault: false };

    assert.deepStrictEqual((await get("/available", "s-imp")).body, {
        enabled: true, canUse: true, canManageOrgs: [], canProvision: true, agentUrlSet: true, ...urlFields, impersonating: true, trustProxyUnsafe: true,
    });
    assert.deepStrictEqual((await get("/available", "s-revealer")).body, {
        enabled: true, canUse: true, canManageOrgs: [20], canProvision: true, agentUrlSet: true, ...urlFields, impersonating: false, trustProxyUnsafe: true,
    });
    assert.deepStrictEqual((await get("/available", "s-invited")).body.canManageOrgs, []);

    const key = process.env.VAULT_KEY;
    try {
        process.env.VAULT_KEY = "";
        state._resetForTests();
        await state.initVaultState();
        assert.deepStrictEqual((await get("/available", "s-revealer")).body, {
            enabled: false, canUse: false, canManageOrgs: [], canProvision: false, agentUrlSet: true, impersonating: false, trustProxyUnsafe: true,
        });
        assert.strictEqual((await get("/items", "s-revealer")).status, 404);
        assert.strictEqual((await get("/settings", "s-revealer")).body.keyStatus, "missing");
    } finally {
        process.env.VAULT_KEY = key;
        state._resetForTests();
        await state.initVaultState();
    }

    const behindOneProxy = await listen(t, { trustProxy: 1 });
    assert.strictEqual((await behindOneProxy.get("/available", "s-owner")).body.trustProxyUnsafe, false);
});

const sshServer = (fields) => Entry.create({ type: "server", config: { protocol: "ssh", ip: "192.0.2.10" }, ...fields });

test("SSH: Zieländerung verwirft die Werte und die gemerkten Host-Keys entfernter Ziele, Benutzer und allowSession nicht; GET liefert hostKeys", async (t) => {
    SYSTEM[1] = ["vault.use", "connect.ssh", "connect.direct"];
    const { get, post, patch } = await listen(t);
    await Account.create({ id: 1, firstName: "Ma", lastName: "Backes", username: "ma", password: "x" });
    const web = await sshServer({ accountId: 1, name: "web02" });
    const created = await post("/items", "s-owner", {
        name: "deploy-ssh", type: "ssh", fields: { username: "deploy", servers: [web.id], hosts: ["NAS.lan:22"] }, secrets: { password: "pw-ssh" },
    });
    const { id } = created.body.item;
    assert.deepStrictEqual([created.status, created.body.item.fields, created.body.item.hostKeys],
        [201, { username: "deploy", servers: [web.id], hosts: ["nas.lan"], allowSession: false }, []]);
    await pinKey({ itemId: id, ref: `server:${web.id}`, algorithm: "ssh-ed25519", fingerprint: "SHA256:web", accountId: 1 });
    await pinKey({ itemId: id, ref: "host:nas.lan", algorithm: "ecdsa-sha2-nistp256", fingerprint: "SHA256:nas", accountId: 1 });

    const sameTargets = await patch(`/items/${id}`, "s-owner", { fields: { username: "root", servers: [web.id], hosts: ["nas.lan"], allowSession: true } });
    assert.deepStrictEqual([sameTargets.status, sameTargets.body.secretsCleared, sameTargets.body.item.secretFields], [200, false, ["password"]]);
    const detail = (await get(`/items/${id}`, "s-owner")).body.item;
    assert.deepStrictEqual(detail.hostKeys.map(({ confirmedAt, ...key }) => ({ ...key, confirmed: Boolean(confirmedAt) })), [
        { target: "host:nas.lan", algorithm: "ecdsa-sha2-nistp256", fingerprint: "SHA256:nas", confirmedBy: { id: 1, name: "Ma Backes" }, confirmed: true },
        { target: `server:${web.id}`, algorithm: "ssh-ed25519", fingerprint: "SHA256:web", confirmedBy: { id: 1, name: "Ma Backes" }, confirmed: true },
    ]);

    const moved = await patch(`/items/${id}`, "s-owner", { fields: { username: "root", servers: [web.id], hosts: [], allowSession: true } });
    assert.deepStrictEqual([moved.status, moved.body.secretsCleared, moved.body.item.secretFields], [200, true, []]);
    assert.deepStrictEqual(moved.body.item.hostKeys.map((key) => key.target), [`server:${web.id}`]);
    assert.strictEqual(await readSecret(id, "password"), null);
    assert.doesNotMatch(moved.text + JSON.stringify(audits), /pw-ssh/);
});

test("SSH-Server als Ziel: nur SSH-Server, die der Speichernde mit connect.ssh verbinden darf, bei Organisations-Einträgen aus derselben Organisation; schon gespeicherte werden nicht erneut geprüft", async (t) => {
    const { post, patch } = await listen(t);
    const own = await sshServer({ accountId: 1, name: "own-web" });
    const ownSecond = await sshServer({ accountId: 1, name: "own-db" });
    const rdp = await Entry.create({ accountId: 1, type: "server", name: "own-rdp", config: { protocol: "rdp", ip: "192.0.2.11" } });
    const foreign = await sshServer({ accountId: 2, name: "foreign-web" });
    const orgServer = await sshServer({ organizationId: 20, name: "org-web" });
    const revealerOwn = await sshServer({ accountId: 3, name: "revealer-web" });
    SYSTEM[1] = ["vault.use", "connect.ssh"];
    SYSTEM[3] = ["settings.vault", "connect.ssh"];
    ORG["3:20"] = ["vault.reveal", "vault.manage", "connect.ssh"];
    const ssh = (name, servers, extra = {}) => ({ name, type: "ssh", fields: { username: "deploy", servers }, secrets: { password: "pw-ssh" }, ...extra });
    const rejected = (id) => [400, `Server ${id} is not an SSH server you can use for this entry`];

    for (const [label, token, body, id] of [
        ["kein SSH-Server", "s-owner", ssh("t-rdp", [rdp.id]), rdp.id],
        ["Server eines anderen Kontos", "s-owner", ssh("t-foreign", [foreign.id]), foreign.id],
        ["Server der Organisation ohne connect.ssh dort", "s-owner", ssh("t-org", [orgServer.id]), orgServer.id],
        ["unbekannter Server", "s-owner", ssh("t-missing", [999999]), 999999],
        ["Organisations-Eintrag mit persönlichem Server", "s-revealer", ssh("t-mixed", [revealerOwn.id], { organizationId: 20 }), revealerOwn.id],
    ]) {
        const res = await post("/items", token, body);
        assert.deepStrictEqual([res.status, res.body.message], rejected(id), label);
    }
    assert.strictEqual((await post("/items", "s-revealer", ssh("org-deploy", [orgServer.id], { organizationId: 20 }))).status, 201);

    const created = await post("/items", "s-owner", ssh("own-deploy", [own.id]));
    assert.strictEqual(created.status, 201);
    const path = `/items/${created.body.item.id}`;
    SYSTEM[1] = ["vault.use"];
    const kept = await patch(path, "s-owner", { fields: { username: "deploy", servers: [own.id] } });
    assert.deepStrictEqual([kept.status, kept.body.secretsCleared], [200, false]);
    const added = await patch(path, "s-owner", { fields: { username: "deploy", servers: [own.id, ownSecond.id] } });
    assert.deepStrictEqual([added.status, added.body.message], rejected(ownSecond.id));
    const removed = await patch(path, "s-owner", { fields: { username: "deploy", servers: [] } });
    assert.deepStrictEqual([removed.status, removed.body.secretsCleared], [200, true]);
});

test("Freie Hosts: neue verlangen connect.direct; unveränderte (auch anders geschrieben) speichern und entfernen nicht", async (t) => {
    const { post, patch } = await listen(t);
    const FREE_HOSTS = [400, "Free hosts need the permission to connect without an entry"];
    const body = { name: "nas-root", type: "ssh", fields: { username: "root", hosts: ["NAS.lan:22", "[FE80::1]:2222"] }, secrets: { password: "pw-nas" } };

    const denied = await post("/items", "s-owner", body);
    assert.deepStrictEqual([denied.status, denied.body.message], FREE_HOSTS);
    SYSTEM[1] = ["vault.use", "connect.direct"];
    const created = await post("/items", "s-owner", body);
    assert.deepStrictEqual([created.status, created.body.item.fields.hosts], [201, ["nas.lan", "[fe80::1]:2222"]]);
    for (const [label, fields] of [
        ["Host mit Leerzeichen", { username: "root", hosts: ["nas lan"] }],
        ["Host mit Pfad", { username: "root", hosts: ["nas.lan/x"] }],
        ["Server als Text", { username: "root", servers: ["web"] }],
        ["allowSession als Text", { username: "root", hosts: ["nas.lan"], allowSession: "yes" }],
    ]) {
        assert.strictEqual((await post("/items", "s-owner", { ...body, name: "nas-bad", fields })).status, 400, label);
    }

    SYSTEM[1] = ["vault.use"];
    const path = `/items/${created.body.item.id}`;
    const hosts = (list) => ({ fields: { username: "root", hosts: list } });
    const same = await patch(path, "s-owner", hosts(["NAS.LAN", "[fe80::1]:2222"]));
    assert.deepStrictEqual([same.status, same.body.secretsCleared], [200, false]);
    const added = await patch(path, "s-owner", hosts(["nas.lan", "backup.lan:2222"]));
    assert.deepStrictEqual([added.status, added.body.message], FREE_HOSTS);
    const removed = await patch(path, "s-owner", hosts(["nas.lan"]));
    assert.deepStrictEqual([removed.status, removed.body.secretsCleared, removed.body.item.fields.hosts], [200, true, ["nas.lan"]]);
});

test("DELETE …/host-keys/:target: mit Bearbeitungsrecht 204 und Audit, danach und bei fremdem Bezeichner 404, ohne Recht 403", async (t) => {
    const { del } = await listen(t);
    const item = await VaultItem.create({
        organizationId: 20, name: "org-nas", type: "ssh", fields: { username: "deploy", servers: [], hosts: ["nas.lan:2222"], allowSession: false },
        approvalRequired: true, allServers: false, createdBy: 3,
    });
    await pinKey({ itemId: item.id, ref: "host:nas.lan:2222", algorithm: "ssh-ed25519", fingerprint: "SHA256:abc", accountId: 3 });
    await db.getQueryInterface().bulkUpdate("vault_items", { updatedAt: new Date(0) }, { id: item.id });
    const updatedAt = async () => new Date((await VaultItem.findByPk(item.id)).updatedAt).getTime();
    const forget = (ref, token) => del(`/items/${item.id}/host-keys/${encodeURIComponent(ref)}`, token);

    assert.strictEqual((await forget("host:nas.lan:2222", "s-owner")).status, 403);
    assert.strictEqual((await forget("host:nas.lan:2222", "s-invited")).status, 404);
    assert.deepStrictEqual([audits, await updatedAt()], [[], 0]);

    assert.strictEqual((await forget("host:nas.lan:2222", "s-revealer")).status, 204);
    assert.strictEqual(await pinnedKey(item.id, "host:nas.lan:2222"), null);
    assert.ok(await updatedAt() > 0, "a stamped session approval of the entry ends");
    assert.deepStrictEqual(audits.map((a) => [a.action, a.organizationId, a.details.item, a.details.target, a.details.fingerprint]),
        [["vault.ssh_host_key_forgotten", 20, "org:20/org-nas", "host:nas.lan:2222", "SHA256:abc"]]);
    assert.strictEqual((await forget("host:nas.lan:2222", "s-revealer")).status, 404);
    assert.strictEqual((await forget("server:abc", "s-revealer")).status, 404);
});

test("Server-Eintrag gelöscht: seine ID verschwindet aus servers aller SSH-Einträge samt gemerktem Key, die Werte bleiben", async (t) => {
    SYSTEM[1] = ["vault.use", "connect.ssh", "resources.manage"];
    const { get, post } = await listen(t);
    const gone = await sshServer({ accountId: 1, name: "old-web" });
    const stays = await sshServer({ accountId: 1, name: "new-web" });
    const { item } = (await post("/items", "s-owner", {
        name: "web-deploy", type: "ssh", fields: { username: "deploy", servers: [gone.id, stays.id] }, secrets: { privateKey: "key-material" },
    })).body;
    for (const entry of [gone, stays])
        await pinKey({ itemId: item.id, ref: `server:${entry.id}`, algorithm: "ssh-ed25519", fingerprint: `SHA256:${entry.name}`, accountId: 1 });

    assert.deepStrictEqual(await deleteEntry(1, gone.id), { success: true });

    const after = (await get(`/items/${item.id}`, "s-owner")).body.item;
    assert.deepStrictEqual([after.fields.servers, after.hostKeys.map((key) => key.target), after.secretFields],
        [[stays.id], [`server:${stays.id}`], ["privateKey"]]);
});

test("allowSession einschalten verlangt eine Login-Session ohne Impersonation; ein schon eingeschaltetes bleibt beim Bearbeiten per Konto-Key", async (t) => {
    SYSTEM[1] = ["vault.use", "connect.direct"];
    const { post, patch } = await listen(t);
    const SESSION_ON = [403, "Allowing approvals for a whole session requires a signed-in session"];
    const fields = (allowSession, username = "root") => ({ username, hosts: ["nas.lan"], allowSession });

    for (const token of ["s-imp", "k-owner"]) {
        const created = await post("/items", token, { name: "nas-session", type: "ssh", fields: fields(true), secrets: { password: "pw-nas" } });
        assert.deepStrictEqual([created.status, created.body.message], SESSION_ON, token);
    }
    const created = await post("/items", "k-owner", { name: "nas-session", type: "ssh", fields: fields(false), secrets: { password: "pw-nas" } });
    assert.strictEqual(created.status, 201);
    const path = `/items/${created.body.item.id}`;

    const switched = await patch(path, "s-imp", { fields: fields(true) });
    assert.deepStrictEqual([switched.status, switched.body.message], SESSION_ON);
    const fromSession = await patch(path, "s-owner", { fields: fields(true) });
    assert.deepStrictEqual([fromSession.status, fromSession.body.item.fields.allowSession], [200, true]);
    const kept = await patch(path, "k-owner", { fields: fields(true, "admin") });
    assert.deepStrictEqual([kept.status, kept.body.item.fields], [200, { ...fields(true, "admin"), servers: [] }]);
});

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

test.beforeEach(() => { audits.length = 0; });

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
    return { get: call("GET"), post: call("POST"), patch: call("PATCH") };
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

    const list = await get("/items", "s-owner");
    assert.deepStrictEqual(list.body.items.map((entry) => entry.ref).sort(), ["org:20/backup-db", "portal-login", "shop-login"]);
    assert.doesNotMatch(list.text + JSON.stringify(audits), /pw-one|pw-two|pw-three|hunter2/);
});

test("available meldet Schalter, Rechte, Agenten-Adresse, Impersonation und TRUST_PROXY=true; bei ausgeschaltetem Vault sind alle Rechte leer", async (t) => {
    const { get, patch } = await listen(t, { trustProxy: true });

    assert.strictEqual((await patch("/settings", "s-owner", { agentUrl: "https://outpost.example.com" })).status, 403);
    assert.deepStrictEqual((await patch("/settings", "s-revealer", { agentUrl: "https://outpost.example.com/" })).body,
        { keyStatus: "active", agentUrl: "https://outpost.example.com", trustProxyUnsafe: true });

    assert.deepStrictEqual((await get("/available", "s-imp")).body, {
        enabled: true, canUse: true, canManageOrgs: [], canProvision: true, agentUrlSet: true, impersonating: true, trustProxyUnsafe: true,
    });
    assert.deepStrictEqual((await get("/available", "s-revealer")).body, {
        enabled: true, canUse: true, canManageOrgs: [20], canProvision: true, agentUrlSet: true, impersonating: false, trustProxyUnsafe: true,
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

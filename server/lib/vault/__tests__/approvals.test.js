const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { Sequelize } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const CALLERS = {
    "s-owner": { user: { id: 1 }, session: { id: 11, accountId: 1, impersonatorId: null } },
    "s-imp": { user: { id: 1 }, session: { id: 12, accountId: 1, impersonatorId: 99 } },
    "k-owner": { user: { id: 1 }, apiKey: { id: 5, kind: "account" } },
};
fake("../../../utils/database", db);
fake("../../../middlewares/auth", {
    authenticate: (req, res, next) => {
        const caller = CALLERS[(req.header("authorization") ?? "").replace(/^Bearer /, "")];
        if (!caller) return res.status(401).json({ message: "The provided token is not valid" });
        Object.assign(req, caller);
        next();
    },
});
fake("../state", { requireVaultEnabled: (req, res, next) => next(), isVaultEnabled: () => true });

const audits = [];
const audit = require("../../../controllers/audit");
audit.createAuditLog = async (entry) => { audits.push(entry); };

const stateBroadcaster = require("../../StateBroadcaster");
const approvals = require("../approvals");
const router = require("../../../routes/vault/approvals");

const ITEM = {
    id: 7, accountId: 1, organizationId: null, name: "portal-login", type: "login", updatedAt: "2026-10-10T08:00:00.000Z",
    fields: { username: "ma", origins: ["https://portal.example.com", "https://sso.example.com"] },
};
const OTHER_ITEMS = [8, 9, 10].map((id) => ({ ...ITEM, id, name: `login-${id}` }));
const call = (overrides = {}) => ({
    accountId: 1, keyId: 5, transportId: "t-1", agentType: "claude", entryName: "web-01",
    item: ITEM, target: "https://portal.example.com", signal: new AbortController().signal, ...overrides,
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

let nextWindow = 100;
const openWindow = (t, accountId, { impersonating = false } = {}) => {
    const messages = [];
    const ws = { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)) };
    stateBroadcaster.register(accountId, nextWindow++, ws, null, null, { impersonating });
    t.after(() => stateBroadcaster.unregister(accountId, ws));
    const approvalsSeen = () => messages.filter((m) => m.type === "VAULT_APPROVALS");
    return { approvalsSeen, cards: () => approvalsSeen().at(-1)?.data ?? [] };
};

test.beforeEach(() => {
    approvals._resetForTests();
    audits.length = 0;
});
test.after(() => approvals._resetForTests());

test("Einmal gibt genau ein Ausfüllen frei; die erste Antwort gewinnt, jede weitere bekommt 409, ein fremdes Konto 404", async (t) => {
    const window = openWindow(t, 1);
    const first = approvals.requestApproval(call());
    await flush();
    const [card] = window.cards();
    assert.deepStrictEqual(Object.keys(card).sort(), ["agentType", "entryName", "expiresAt", "id", "impersonated", "item", "remainingMs", "target"]);
    assert.deepStrictEqual([card.item, card.agentType, card.entryName, card.impersonated, card.target], ["portal-login", "claude", "web-01", false, "https://portal.example.com"]);

    assert.deepStrictEqual(approvals.answerApproval(card.id, 2, "once"), { status: 404 });
    assert.deepStrictEqual(approvals.answerApproval(card.id, 1, "once"), { status: 200 });
    assert.deepStrictEqual(approvals.answerApproval(card.id, 1, "deny"), { status: 409 });
    assert.strictEqual(await first, "once");
    await flush();
    assert.deepStrictEqual(window.cards(), []);
    assert.deepStrictEqual(audits.map((a) => [a.action, a.resource, a.resourceId, a.details.decision, a.details.item]), [["vault.approve", "vault", 7, "once", "portal-login"]]);

    const second = approvals.requestApproval(call());
    await flush();
    assert.strictEqual(window.cards().length, 1, "once is not remembered");
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    assert.strictEqual(await second, "once");
});

test("Für diese Sitzung gilt bis zum Ende des Transports, nur für ihn und nur für den unveränderten Eintrag", async (t) => {
    const window = openWindow(t, 1);
    const first = approvals.requestApproval(call());
    await flush();
    approvals.answerApproval(window.cards()[0].id, 1, "session");
    assert.strictEqual(await first, "session");

    assert.strictEqual(await approvals.requestApproval(call()), "session");
    const reordered = { ...ITEM, fields: { ...ITEM.fields, origins: [...ITEM.fields.origins].reverse() } };
    assert.strictEqual(approvals.hasSessionApproval("t-1", reordered), true);
    await flush();
    assert.deepStrictEqual(window.cards(), []);

    const moved = { ...ITEM, fields: { ...ITEM.fields, origins: ["https://portal.example.net"] } };
    assert.strictEqual(approvals.hasSessionApproval("t-1", moved), false);
    const edited = { ...ITEM, updatedAt: "2026-10-10T08:05:00.000Z" };
    const afterEdit = approvals.requestApproval(call({ item: edited }));
    await flush();
    assert.strictEqual(window.cards().length, 1, "an edited entry needs a new card");
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    assert.strictEqual(await afterEdit, "once");

    const otherTransport = approvals.requestApproval(call({ transportId: "t-2" }));
    await flush();
    assert.strictEqual(window.cards().length, 1);
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    await otherTransport;

    approvals.forgetTransport("t-1");
    assert.strictEqual(approvals.hasSessionApproval("t-1", ITEM), false);
});

test("Ablehnen sperrt denselben Aufrufer für denselben Eintrag 60 s, auch über einen neuen Transport", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const window = openWindow(t, 1);
    const first = approvals.requestApproval(call());
    await flush();
    approvals.answerApproval(window.cards()[0].id, 1, "deny");
    await assert.rejects(first, { code: "vault.approval_denied", details: {} });
    assert.deepStrictEqual(audits.map((a) => a.action), ["vault.deny"]);

    t.mock.timers.tick(59_999);
    await assert.rejects(approvals.requestApproval(call({ transportId: "t-2" })), { code: "vault.approval_denied", details: { early: true } });
    await flush();
    assert.deepStrictEqual(window.cards(), []);
    assert.deepStrictEqual(audits.map((a) => a.action), ["vault.deny"]);

    const otherCaller = approvals.requestApproval(call({ keyId: 6, transportId: "t-3" }));
    await flush();
    assert.strictEqual(window.cards().length, 1, "another key of the account is not locked");
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    await otherCaller;

    t.mock.timers.tick(1);
    const afterLock = approvals.requestApproval(call({ transportId: "t-2" }));
    await flush();
    assert.strictEqual(window.cards().length, 1);
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    assert.strictEqual(await afterLock, "once");
});

test("ohne Antwort läuft die Anfrage nach 120 s ab; eine spätere Antwort bekommt 410", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    const window = openWindow(t, 1);
    const pending = approvals.requestApproval(call());
    const outcome = assert.rejects(pending, { code: "vault.approval_timeout", details: {} });
    await flush();
    const [card] = window.cards();
    assert.deepStrictEqual([card.expiresAt, card.remainingMs], [new Date(1_000_000 + approvals.APPROVAL_TTL_MS).toISOString(), approvals.APPROVAL_TTL_MS]);

    t.mock.timers.tick(approvals.APPROVAL_TTL_MS - 1);
    await flush();
    assert.strictEqual(window.cards().length, 1);
    assert.strictEqual(approvals.listOpenApprovals(1)[0].remainingMs, 1);
    t.mock.timers.tick(1);
    await outcome;
    await flush();
    assert.deepStrictEqual(window.cards(), []);
    assert.deepStrictEqual(audits.map((a) => [a.action, a.details.reason]), [["vault.approval_timeout", "expired"]]);
    assert.deepStrictEqual(approvals.answerApproval(card.id, 1, "once"), { status: 410 });
});

test("bricht der Client ab, wird die Anfrage sofort zurückgezogen und als client_gone auditiert; ein schon abgebrochener Aufruf bekommt keine Karte", async (t) => {
    const window = openWindow(t, 1);
    const controller = new AbortController();
    const pending = approvals.requestApproval(call({ signal: controller.signal }));
    await flush();
    const [card] = window.cards();

    controller.abort();
    await assert.rejects(pending, { code: "vault.client_gone", details: {} });
    await assert.rejects(approvals.requestApproval(call({ signal: AbortSignal.abort() })), { code: "vault.client_gone", details: { early: true } });
    await flush();
    assert.deepStrictEqual(window.cards(), []);
    assert.deepStrictEqual(audits.map((a) => [a.action, a.details.reason]), [["vault.approval_timeout", "client_gone"]]);
    assert.deepStrictEqual(approvals.answerApproval(card.id, 1, "once"), { status: 410 });
});

test("ohne verbundenes Fenster sofort approval_unavailable; ein Impersonations-Fenster zählt nicht und sieht keine Karte", async (t) => {
    await assert.rejects(approvals.requestApproval(call()), { code: "vault.approval_unavailable", details: { early: true } });

    const impersonated = openWindow(t, 1, { impersonating: true });
    await assert.rejects(approvals.requestApproval(call()), { code: "vault.approval_unavailable", details: { early: true } });
    assert.deepStrictEqual(audits, []);

    const window = openWindow(t, 1);
    const pending = approvals.requestApproval(call());
    await flush();
    assert.strictEqual(window.cards().length, 1);
    approvals.answerApproval(window.cards()[0].id, 1, "once");
    await pending;
    await flush();
    assert.deepStrictEqual(impersonated.approvalsSeen(), []);
});

test("ein zweiter Aufruf für dieselbe offene Anfrage bekommt sofort approval_pending", async (t) => {
    const window = openWindow(t, 1);
    const first = approvals.requestApproval(call());
    await assert.rejects(approvals.requestApproval(call()), { code: "vault.approval_pending", details: { early: true } });
    const otherTransport = approvals.requestApproval(call({ transportId: "t-2" }));
    await flush();
    assert.strictEqual(window.cards().length, 2);
    for (const card of window.cards()) approvals.answerApproval(card.id, 1, "once");
    assert.deepStrictEqual(await Promise.all([first, otherTransport]), ["once", "once"]);
});

test("ab der vierten offenen Anfrage desselben Aufrufers approval_busy", async (t) => {
    const window = openWindow(t, 1);
    const open = OTHER_ITEMS.map((item) => approvals.requestApproval(call({ item })));
    await assert.rejects(approvals.requestApproval(call()), { code: "vault.approval_busy", details: { early: true } });
    const otherKey = approvals.requestApproval(call({ keyId: 6, transportId: "t-9" }));
    await flush();
    assert.strictEqual(window.cards().length, 4);
    for (const card of window.cards()) approvals.answerApproval(card.id, 1, "once");
    await Promise.all([...open, otherKey]);
});

test("Freigabe-Antworten nur aus einer Login-Session: Impersonation und Konto-Key bekommen 403; eine Anfrage aus einer Impersonation gibt es nur einmal frei", async (t) => {
    openWindow(t, 1);
    const app = express();
    app.use(express.json());
    app.use("/api/vault", router);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    t.after(() => server.close());
    const pending = approvals.requestApproval(call({ impersonated: true }));
    const [{ id, impersonated }] = approvals.listOpenApprovals(1);
    assert.strictEqual(impersonated, true);
    const answer = (token, body = { decision: "once" }) => fetch(`http://127.0.0.1:${server.address().port}/api/vault/approvals/${id}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });

    assert.strictEqual((await answer("s-imp")).status, 403);
    assert.strictEqual((await answer("k-owner")).status, 403);
    assert.strictEqual((await answer("s-owner", { decision: "always" })).status, 400);
    const session = await answer("s-owner", { decision: "session" });
    assert.deepStrictEqual([session.status, (await session.json()).code], [400, "vault.session_not_allowed"]);
    assert.strictEqual(approvals.listOpenApprovals(1).length, 1, "the request stays open");
    assert.strictEqual((await answer("s-owner")).status, 200);
    assert.strictEqual(await pending, "once");
    assert.strictEqual((await answer("s-owner")).status, 409);
});

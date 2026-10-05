const test = require("node:test");
const assert = require("node:assert");
const Entry = require("../../models/Entry");
const entryController = require("../../controllers/entry");
const identityResolver = require("../../utils/identityResolver");
const permission = require("../../utils/permission");
const audit = require("../../controllers/audit");
const ConnectionService = require("../ConnectionService");
const stateBroadcaster = require("../StateBroadcaster");
const SessionManager = require("../SessionManager");

// Patched before the controller is required: it destructures these at load time.
let accessAllowed = true;
let beforeAccessCheck = async () => {};
const auditCalls = [];
const connectCalls = [];
entryController.validateEntryAccess = async () => { await beforeAccessCheck(); return { valid: accessAllowed }; };
identityResolver.resolveIdentity = async (entry, identityId, directIdentity) =>
    ({ identity: directIdentity ? { isDirect: true } : { id: identityId } });
permission.hasAccountPermission = async () => true;
audit.createAuditLog = async (entry) => { auditCalls.push(entry); return 900 + auditCalls.length; };
audit.getOrganizationAuditSettingsInternal = async () => null;
ConnectionService.createConnectionForSession = async (sessionId) => { connectCalls.push(sessionId); return { success: true }; };
stateBroadcaster.broadcast = () => {};

const { reconnectSession, deleteSession, hibernateSession, resumeSession } = require("../../controllers/serverSession");

Entry.findByPk = async (id) => (id === 101
    ? { id: 101, type: "server", organizationId: null, renderer: "terminal", config: { protocol: "ssh", ip: "10.0.0.1" } }
    : null);

const ACCOUNT = 7;
const request = { ipAddress: "10.0.0.9", userAgent: "test" };

const sshConfiguration = () => ({
    identityId: 3, type: null, directIdentity: null, scriptId: null, startPath: null,
    tmuxSession: "claude", tmuxCreate: false, tmuxWindowId: null, displayDpi: null,
    renderer: "terminal", directTarget: null, protocol: "ssh",
});

const liveSession = () => SessionManager.create(ACCOUNT, 101, sshConfiguration(), "maintenance", "tab-1", "browser-1", 11, null);

const retired = async (configuration = sshConfiguration(), entryId = 101) => {
    const session = SessionManager.create(ACCOUNT, entryId, configuration, "maintenance", "tab-1", "browser-1", 11, null);
    await SessionManager.remove(session.sessionId, { code: 4017, reason: "Connection lost" });
    return session.sessionId;
};

test("Reconnect liefert dieselbe ID mit nächster Generation und der gespeicherten Konfiguration", async () => {
    const id = await retired();
    assert.deepStrictEqual(await reconnectSession(ACCOUNT, id, { ...request, displayDpi: 144 }), { sessionId: id, generation: 2 });
    const session = SessionManager.get(id);
    assert.strictEqual(session.engineSessionId, `${id}:2`);
    assert.strictEqual(session.connectionReason, "maintenance");
    assert.strictEqual(session.configuration.tmuxSession, "claude");
    assert.strictEqual(session.configuration.tmuxCreate, true);
    assert.strictEqual(session.configuration.displayDpi, 144);
    assert.deepStrictEqual([session.tabId, session.browserId], ["tab-1", "browser-1"]);
    assert.strictEqual(SessionManager.getTombstone(id), null);
    assert.ok(connectCalls.includes(id));

    const directIdentity = { type: "password", username: "u", password: "p" };
    const directTarget = { host: "10.0.0.5", port: 22, protocol: "ssh" };
    const directId = await retired({ ...sshConfiguration(), identityId: null, tmuxSession: null, directIdentity, directTarget }, null);
    assert.strictEqual((await reconnectSession(ACCOUNT, directId, request)).generation, 2);
    assert.deepStrictEqual(SessionManager.get(directId).configuration.directIdentity, directIdentity);
    assert.deepStrictEqual(SessionManager.get(directId).configuration.directTarget, directTarget);

    await SessionManager.remove(id);
    await SessionManager.remove(directId);
});

test("zwei gleichzeitige Reconnects ergeben genau eine neue Sitzung", async () => {
    const id = await retired();
    const before = connectCalls.length;
    const [a, b] = await Promise.all([reconnectSession(ACCOUNT, id, request), reconnectSession(ACCOUNT, id, request)]);
    assert.deepStrictEqual(a, { sessionId: id, generation: 2 });
    assert.deepStrictEqual(b, a);
    assert.strictEqual(connectCalls.length - before, 1);
    await SessionManager.remove(id);
});

test("Reconnect lehnt ab: fremdes Konto 404, Rechte entzogen 403, abgelaufen 410", async (t) => {
    const id = await retired();
    assert.strictEqual((await reconnectSession(8, id, request)).code, 404);

    accessAllowed = false;
    try {
        assert.strictEqual((await reconnectSession(ACCOUNT, id, request)).code, 403);
    } finally {
        accessAllowed = true;
    }
    assert.ok(SessionManager.getTombstone(id), "eine Ablehnung verbraucht den Tombstone nicht");

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    t.mock.timers.tick(SessionManager.TOMBSTONE_TTL_MS + 1);
    assert.strictEqual((await reconnectSession(ACCOUNT, id, request)).code, 410);
    assert.strictEqual((await reconnectSession(ACCOUNT, "00000000-0000-4000-8000-000000000000", request)).code, 410);

    const raced = await retired();
    beforeAccessCheck = () => SessionManager.removeAllByAccountId(ACCOUNT);
    try {
        assert.strictEqual((await reconnectSession(ACCOUNT, raced, request)).code, 410);
    } finally {
        beforeAccessCheck = async () => {};
    }
    assert.ok(!SessionManager.get(raced), "logout during a reconnect leaves no live generation");
});

test("Reconnect schreibt entry.reconnect ins Audit-Log und hängt die neue Generation daran", async () => {
    const id = await retired();
    await reconnectSession(ACCOUNT, id, request);
    const entry = auditCalls.at(-1);
    assert.strictEqual(entry.action, "entry.reconnect");
    assert.strictEqual(entry.action, audit.AUDIT_ACTIONS.RECONNECT);
    assert.deepStrictEqual(
        { resource: entry.resource, resourceId: entry.resourceId, details: entry.details, ipAddress: entry.ipAddress },
        { resource: "entry", resourceId: 101, details: { reconnectOf: id, generation: 2, connectionReason: "maintenance" }, ipAddress: "10.0.0.9" },
    );
    assert.strictEqual(SessionManager.get(id).auditLogId, 900 + auditCalls.length);
    await SessionManager.remove(id);
});

test("lebt die Sitzung noch, antwortet Reconnect 409 und ändert nichts", async () => {
    const session = liveSession();
    const audits = auditCalls.length;
    const connects = connectCalls.length;
    assert.strictEqual((await reconnectSession(ACCOUNT, session.sessionId, request)).code, 409);
    assert.strictEqual(SessionManager.get(session.sessionId), session);
    assert.strictEqual(session.generation, 1);
    assert.strictEqual(auditCalls.length, audits);
    assert.strictEqual(connectCalls.length, connects);
    await SessionManager.remove(session.sessionId);
});

test("ein Reconnect während der Karenz wartet deren Ausgang ab", async () => {
    const session = liveSession();
    SessionManager.beginCloseGrace(session.sessionId, 1);
    const pending = reconnectSession(ACCOUNT, session.sessionId, request);
    await SessionManager.remove(session.sessionId, { code: 4017, reason: "Connection lost", generation: 1 });
    assert.deepStrictEqual(await pending, { sessionId: session.sessionId, generation: 2 });
    await SessionManager.remove(session.sessionId);

    const ended = liveSession();
    SessionManager.beginCloseGrace(ended.sessionId, 1);
    const endedPending = reconnectSession(ACCOUNT, ended.sessionId, request);
    await SessionManager.remove(ended.sessionId, { generation: 1 });
    assert.deepStrictEqual(await endedPending, { code: 404, message: "Session ended" });
});

test("fremde Konten können weder löschen noch schlafen legen noch fortsetzen; DELETE gewinnt gegen laufenden Reconnect", async () => {
    const id = await retired();
    assert.strictEqual((await deleteSession(8, id)).code, 404);
    assert.ok(SessionManager.getTombstone(id));
    assert.deepStrictEqual(await deleteSession(ACCOUNT, id), { message: "Session deleted" });
    assert.strictEqual(SessionManager.getTombstone(id), null);

    const racing = await retired();
    const pending = reconnectSession(ACCOUNT, racing, request);
    await deleteSession(ACCOUNT, racing);
    assert.strictEqual((await pending).code, 410);
    assert.strictEqual(SessionManager.get(racing), null);

    const live = liveSession();
    assert.strictEqual(hibernateSession(8, live.sessionId).code, 404);
    assert.strictEqual(resumeSession(8, live.sessionId, "evil-tab", "evil-browser").code, 404);
    assert.deepStrictEqual([live.isHibernated, live.tabId, live.browserId], [false, "tab-1", "browser-1"]);
    await SessionManager.remove(live.sessionId);
});

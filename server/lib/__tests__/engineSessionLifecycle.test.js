const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const SessionManager = require("../SessionManager");
const controlPlane = require("../controlPlane/ControlPlaneServer");
const { bindDataSocketLifecycle } = require("../ConnectionService");
const GuacdClient = require("../GuacdClient");
const { handleSessionClosed, handleEngineDisconnected } = require("../engineEvents");

controlPlane.closeSession = () => {};

const fakeSocket = () => Object.assign(new EventEmitter(), { write() {}, end() {}, destroy() {} });

const connectedSession = (protocol = "ssh") => {
    const session = SessionManager.create(1, 2, { protocol });
    const socket = fakeSocket();
    bindDataSocketLifecycle(session.sessionId, session.generation, socket, "SSH");
    SessionManager.setConnection(session.sessionId,
        { type: protocol, dataSocket: socket, sessionId: session.engineSessionId }, session.generation);
    return { session, socket };
};

test("schließt der Daten-Socket vor der Engine-Meldung, entscheidet die Meldung über den Tombstone", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const lost = connectedSession();
    lost.socket.emit("close");
    assert.ok(SessionManager.get(lost.session.sessionId), "während der Karenz lebt die Sitzung");
    handleSessionClosed({ sessionId: lost.session.engineSessionId, reason: "connection lost" });
    await SessionManager.whenEnded(lost.session.sessionId);
    assert.strictEqual(SessionManager.getTombstone(lost.session.sessionId)?.reason, "Connection lost");

    const ended = connectedSession();
    ended.socket.emit("close");
    handleSessionClosed({ sessionId: ended.session.engineSessionId, reason: "session ended" });
    await SessionManager.whenEnded(ended.session.sessionId);
    assert.strictEqual(SessionManager.getTombstone(ended.session.sessionId), null);

    const silent = connectedSession();
    silent.socket.emit("close");
    t.mock.timers.tick(SessionManager.CLOSE_GRACE_MS);
    await SessionManager.whenEnded(silent.session.sessionId);
    assert.strictEqual(SessionManager.get(silent.session.sessionId), null);
    assert.strictEqual(SessionManager.getTombstone(silent.session.sessionId), null);
});

test("ein RDP-Logoff (Guacamole-Status 0x020B) hinterlässt keinen Tombstone, ein Abbruch schon", async () => {
    const end = async (instruction) => {
        const session = SessionManager.create(1, 2, { protocol: "rdp" });
        const socket = fakeSocket();
        const client = new GuacdClient({
            sessionId: session.sessionId,
            generation: session.generation,
            engineSessionId: session.engineSessionId,
            existingSocket: socket,
            connectionSettings: { connection: { type: "rdp" } },
        });
        client.connect();
        socket.emit("data", "4.args,13.VERSION_1_5_0;");
        socket.emit("data", instruction);
        await SessionManager.whenEnded(session.sessionId);
        SessionManager.consumeFailedReason(session.sessionId);
        return SessionManager.getTombstone(session.sessionId);
    };

    assert.strictEqual(await end("5.error,11.Logged off.,3.523;"), null);
    assert.strictEqual((await end("5.error,15.Connection lost,3.514;"))?.reason, "error: Connection lost");
});

test("ein Engine-Abbruch hinterlässt einen Tombstone, auch wenn der Daten-Socket vorher schließt", async () => {
    const { session, socket } = connectedSession();
    socket.emit("close");
    handleEngineDisconnected({ engineId: "engine-1", sessionIds: [session.engineSessionId, `${session.sessionId}-xfer-1`] });
    await SessionManager.whenEnded(session.sessionId);
    assert.strictEqual(SessionManager.getTombstone(session.sessionId)?.reason, "Engine disconnected");
});

test("verspätete Meldungen der alten Generation lassen die neue leben", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const first = SessionManager.create(1, 2, { protocol: "ssh" });
    const { sessionId } = first;
    const oldSocket = fakeSocket();
    bindDataSocketLifecycle(sessionId, first.generation, oldSocket, "SSH");
    handleSessionClosed({ sessionId: first.engineSessionId, reason: "connection lost" });
    await SessionManager.whenEnded(sessionId);

    const second = SessionManager.create(1, 2, { protocol: "ssh" }, null, null, null, null, null, { sessionId, generation: 2 });
    handleSessionClosed({ sessionId: first.engineSessionId, reason: "session ended" });
    oldSocket.emit("close");
    t.mock.timers.tick(SessionManager.CLOSE_GRACE_MS);

    assert.strictEqual(SessionManager.get(sessionId), second);
    assert.strictEqual(second._removing, undefined);
    assert.strictEqual(second._closeGrace, null);
    await SessionManager.remove(sessionId);
});

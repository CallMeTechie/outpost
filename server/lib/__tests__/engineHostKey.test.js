const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const flatbuffers = require("flatbuffers");
const controlPlane = require("../controlPlane/ControlPlaneServer");
const { openEngineSession } = require("../ConnectionService");
const EngineSftpClient = require("../EngineSftpClient");
const {
    Envelope, MessageType, SessionOpenResult, SessionType, ErrorCode,
} = require("../generated/control_plane_generated");
const { SftpMessage, SftpMsgType, ExecRes, ErrorRes } = require("../generated/sftp_protocol_generated");

const ENGINE = "host-key-test";
const KEY = { algorithm: "ssh-ed25519", fingerprint: "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU" };

const sessionOpenResult = (sessionId, { success, errorCode = ErrorCode.None, errorMessage = null, hostKey = null }) => {
    const b = new flatbuffers.Builder(256);
    const sid = b.createString(sessionId);
    const message = errorMessage ? b.createString(errorMessage) : 0;
    const algorithm = hostKey ? b.createString(hostKey.algorithm) : 0;
    const fingerprint = hostKey ? b.createString(hostKey.fingerprint) : 0;
    SessionOpenResult.startSessionOpenResult(b);
    SessionOpenResult.addSessionId(b, sid);
    SessionOpenResult.addSuccess(b, success);
    SessionOpenResult.addErrorCode(b, errorCode);
    if (message) SessionOpenResult.addErrorMessage(b, message);
    if (algorithm) SessionOpenResult.addHostKeyAlgorithm(b, algorithm);
    if (fingerprint) SessionOpenResult.addHostKeyFingerprint(b, fingerprint);
    const result = SessionOpenResult.endSessionOpenResult(b);
    Envelope.startEnvelope(b);
    Envelope.addMsgType(b, MessageType.SessionOpenResult);
    Envelope.addSessionOpenResult(b, result);
    Envelope.finishEnvelopeBuffer(b, Envelope.endEnvelope(b));
    return Envelope.getRootAsEnvelope(new flatbuffers.ByteBuffer(b.asUint8Array()));
};

const fakeEngine = (t, sessionIds) => {
    const socket = {};
    const sent = [];
    const sendFrame = controlPlane._sendFrame;
    controlPlane._sendFrame = (_socket, frame) => sent.push(Envelope.getRootAsEnvelope(new flatbuffers.ByteBuffer(frame)).sessionOpen());
    controlPlane._engines.set(ENGINE, { socket, engineId: ENGINE });
    t.after(() => {
        controlPlane._sendFrame = sendFrame;
        controlPlane._engines.delete(ENGINE);
        for (const id of sessionIds) controlPlane._sessionEngineMap.delete(id);
    });
    const answer = (sessionId, result) =>
        controlPlane._handleControlMessage(socket, sessionOpenResult(sessionId, result), MessageType.SessionOpenResult);
    return { sent, answer };
};

test("openSession hands the engine the host-key options and returns the host key it reports, also with a mismatch", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { sent, answer } = fakeEngine(t, ["vault-ssh-run", "vault-ssh-mismatch", "vault-ssh-probe", "vault-ssh-silent"]);
    const optionsOf = (open) => [open.expectedHostKey(), open.probeHostKey(), open.execOnly()];

    const run = controlPlane.openSession("vault-ssh-run", SessionType.SFTP, "10.0.0.5", 22, { username: "deploy" }, [], ENGINE,
        { expectedHostKey: KEY.fingerprint, execOnly: true });
    assert.deepStrictEqual(optionsOf(sent[0]), [KEY.fingerprint, false, true]);
    answer("vault-ssh-run", { success: true, hostKey: KEY });
    assert.deepStrictEqual(await run,
        { success: true, errorMessage: null, connectionId: null, sessionId: "vault-ssh-run", hostKey: KEY });

    const mismatch = controlPlane.openSession("vault-ssh-mismatch", SessionType.SFTP, "10.0.0.5", 22, { username: "deploy" }, [], ENGINE,
        { expectedHostKey: "SHA256:remembered" });
    answer("vault-ssh-mismatch", { success: false, errorCode: ErrorCode.HostKeyMismatch, errorMessage: "Host key mismatch", hostKey: KEY });
    await assert.rejects(mismatch, { message: "Host key mismatch", errorCode: "HostKeyMismatch", hostKey: KEY });

    const probe = controlPlane.openSession("vault-ssh-probe", SessionType.SFTP, "10.0.0.5", 22, { username: "deploy" }, [], ENGINE,
        { probeHostKey: true });
    assert.deepStrictEqual(optionsOf(sent[2]), [null, true, false]);
    answer("vault-ssh-probe", { success: true, hostKey: KEY });
    assert.deepStrictEqual((await probe).hostKey, KEY);

    const silent = controlPlane.openSession("vault-ssh-silent", SessionType.SFTP, "10.0.0.5", 22, { username: "deploy" }, [], ENGINE);
    assert.deepStrictEqual(optionsOf(sent[3]), [null, false, false]);
    t.mock.timers.tick(30000);
    await assert.rejects(silent, { message: "Request timeout", errorCode: "Timeout" });
});

class FakeSocket extends EventEmitter {
    constructor() {
        super();
        this.writableLength = 0;
        this.written = [];
    }
    write(chunk) { this.written.push(chunk); return true; }
    destroy() {}
    sentMessages() {
        return this.written.filter((_, i) => i % 2 === 1)
            .map((payload) => SftpMessage.getRootAsSftpMessage(new flatbuffers.ByteBuffer(new Uint8Array(payload))));
    }
}

const emitMessage = (socket, rid, msgType, build) => {
    const b = new flatbuffers.Builder(128);
    const addRes = build(b);
    SftpMessage.startSftpMessage(b);
    SftpMessage.addMsgType(b, msgType);
    SftpMessage.addRequestId(b, rid);
    addRes();
    SftpMessage.finishSftpMessageBuffer(b, SftpMessage.endSftpMessage(b));
    const payload = Buffer.from(b.asUint8Array());
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    socket.emit("data", Buffer.concat([header, payload]));
};

test("exec reports whether the engine stopped the command at its timeout", async () => {
    const socket = new FakeSocket();
    const client = new EngineSftpClient(socket);
    const answer = (rid, { exitCode, timedOut }) => emitMessage(socket, rid, SftpMsgType.ExecResult, (b) => {
        const stdout = b.createString("partial");
        const stderr = b.createString("");
        ExecRes.startExecRes(b);
        ExecRes.addStdoutData(b, stdout);
        ExecRes.addStderrData(b, stderr);
        ExecRes.addExitCode(b, exitCode);
        ExecRes.addTimedOut(b, timedOut);
        const res = ExecRes.endExecRes(b);
        return () => SftpMessage.addExecRes(b, res);
    });

    const slow = client.exec("sleep 100", 1000);
    answer(client._requestId, { exitCode: 124, timedOut: true });
    assert.deepStrictEqual(await slow, { stdout: "partial", stderr: "", exitCode: 124, timedOut: true });

    const quick = client.exec("true", 1000);
    answer(client._requestId, { exitCode: 0, timedOut: false });
    assert.deepStrictEqual(await quick, { stdout: "partial", stderr: "", exitCode: 0, timedOut: false });
});

test("a failed open closes the data connection the engine reports afterwards, so no session stays behind", async (t) => {
    const { answer } = fakeEngine(t, ["vault-ssh-late"]);
    const opening = openEngineSession("vault-ssh-late", SessionType.SFTP, "10.0.0.5", 22, { username: "deploy" }, [], ENGINE,
        { execOnly: true });
    answer("vault-ssh-late", { success: false, errorCode: ErrorCode.AuthFailed, errorMessage: "SSH authentication failed" });
    await assert.rejects(opening, { errorCode: "AuthFailed" });

    let destroyed = false;
    controlPlane.emit("dataConnectionReady", { sessionId: "vault-ssh-late", socket: { destroy: () => { destroyed = true; } } });
    await new Promise(setImmediate);
    assert.strictEqual(destroyed, true);
});

test("stat and writeFile hand the engine the owner, exclusive and final-mode options; only a refused WriteBegin is marked notOpened", async () => {
    const socket = new FakeSocket();
    const client = new EngineSftpClient(socket);
    const calls = [
        client.stat("/srv/app/a"),
        client.stat("/srv/app/b", { owner: false }),
        client.writeFile("/srv/app/.c.outpost-1f2e.tmp", Buffer.from("x"), { exclusive: true, finalMode: 0o640 }),
        client.writeFile("/srv/app/d", Buffer.from("x")),
    ];
    client.close();
    for (const call of calls) await assert.rejects(call, (err) => err.message === "Connection closed" && err.notOpened === undefined);

    const options = socket.sentMessages().map((m) => (m.msgType() === SftpMsgType.Stat
        ? m.pathReq().owner()
        : [m.writeBeginReq().exclusive(), m.writeBeginReq().finalMode()]));
    assert.deepStrictEqual(options, [true, false, [true, 0o640], [false, 0]]);

    const refusing = new FakeSocket();
    const refused = new EngineSftpClient(refusing);
    const write = refused.writeFile("/srv/app/.e.outpost-2a3b.tmp", Buffer.from("x"), { exclusive: true });
    emitMessage(refusing, refused._requestId, SftpMsgType.Error, (b) => {
        const message = b.createString("Already exists");
        ErrorRes.startErrorRes(b);
        ErrorRes.addMessage(b, message);
        const res = ErrorRes.endErrorRes(b);
        return () => SftpMessage.addErrorRes(b, res);
    });
    await assert.rejects(write, { message: "Already exists", notOpened: true });
});

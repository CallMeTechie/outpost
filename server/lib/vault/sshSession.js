const { randomUUID } = require("node:crypto");
const controlPlane = require("../controlPlane/ControlPlaneServer");
const EngineSftpClient = require("../EngineSftpClient");
const { SessionType } = require("../generated/control_plane_generated");
const { openEngineSession, resolveJumpHosts, resolveFileTransferContext } = require("../ConnectionService");
const ApiKey = require("../../models/ApiKey");
const Entry = require("../../models/Entry");
const { validateEntryAccess } = require("../../controllers/entry");
const { hasAccountPermission } = require("../../utils/permission");
const { Permission } = require("../../permissions/registry");
const { VaultError, VaultErrorCode, VaultErrorMessage } = require("./errors");
const { targetRefsOf, parseTargetRef, usableSshServer } = require("./sshTargets");

const KIND = Object.freeze({
    CONNECTION: "connection", TIMEOUT: "timeout", LOGIN: "login refused", ENGINE: "engine not connected", SFTP: "SFTP not available",
});

const unavailable = () => new VaultError(VaultErrorCode.TARGET_UNAVAILABLE);
const newSessionId = () => `vault-ssh-${randomUUID()}`;
const closeEngineSession = (sessionId, target) => {
    try {
        controlPlane.closeSession(sessionId, target.engineId);
    } catch {}
};

const OUTCOME = Object.freeze({
    NOTHING: "nothing was done.",
    SENT: "the command was sent and may have run in full or in part. Check on the target before running it again.",
});

const sshFailed = (target, kind, { sent = false } = {}) => new VaultError(VaultErrorCode.SSH_FAILED,
    VaultErrorMessage[VaultErrorCode.SSH_FAILED].replace("<target>", () => target.ref).replace("<kind>", () => kind)
        .replace("<outcome>", () => (sent ? OUTCOME.SENT : OUTCOME.NOTHING))
    + (kind === KIND.LOGIN ? " Ask the user to check the entry's user and key." : ""));

const hostKeyChanged = (ref, expected, actual) => new VaultError(VaultErrorCode.HOST_KEY_CHANGED,
    VaultErrorMessage[VaultErrorCode.HOST_KEY_CHANGED].replace("<target>", () => ref).replace("<alt>", () => expected).replace("<neu>", () => actual),
    { expected, actual });

// Engine errors only ever leave as one of these kinds: their text may name hosts behind jump hosts or libssh2 details.
const sshFailure = (err, target, signal = null, { sent = false } = {}) => {
    if (err instanceof VaultError) return err;
    if (signal?.aborted) return new VaultError(VaultErrorCode.CLIENT_GONE);
    const message = String(err?.message ?? "");
    const failed = (kind) => sshFailed(target, kind, { sent });
    if (err?.errorCode === "AuthFailed") return failed(KIND.LOGIN);
    if (message.includes("SFTP not available")) return failed(KIND.SFTP);
    if (message === "No engine connected") return failed(KIND.ENGINE);
    if (err?.errorCode === "Timeout" || /timeout/i.test(message)) return failed(KIND.TIMEOUT);
    return failed(KIND.CONNECTION);
};

const resolveTarget = async (item, ref, ctx, { withJumpHosts = true } = {}) => {
    const parsed = typeof ref === "string" ? parseTargetRef(ref) : null;
    if (!parsed || !targetRefsOf(item).includes(ref)) throw new VaultError(VaultErrorCode.TARGET_NOT_ALLOWED);
    if (parsed.kind === "host") {
        if (!(await hasAccountPermission(ctx.accountId, Permission.CONNECT_DIRECT))) throw unavailable();
        return { ref, kind: "host", name: ref.slice("host:".length), host: parsed.host, port: parsed.port, jumpHosts: [], engineId: null };
    }
    const entry = await usableSshServer(ctx.accountId, item.organizationId ?? null, parsed.entryId);
    if (!entry) throw unavailable();
    const jumpHosts = withJumpHosts ? await resolveJumpHosts(entry).catch(() => { throw unavailable(); }) : [];
    return {
        ref, kind: "server", name: entry.name, host: entry.config.ip, port: Number(entry.config.port) || 22,
        jumpHosts, engineId: entry.config.engineId ?? null,
    };
};

const assertEngine = (target) => {
    const connected = target.engineId ? controlPlane.getEngineInfo(target.engineId) !== null : controlPlane.hasEngine();
    if (!connected) throw sshFailed(target, KIND.ENGINE);
};

// Only the username: sftp_session_thread stops without one, and nothing secret may reach a target before its key is confirmed.
const probeHostKey = async (target, username) => {
    const sessionId = newSessionId();
    try {
        const result = await controlPlane.openSession(sessionId, SessionType.SFTP, target.host, target.port, { username },
            target.jumpHosts, target.engineId, { probeHostKey: true });
        if (!result?.hostKey?.fingerprint) throw new Error("No host key");
        return { algorithm: result.hostKey.algorithm, fingerprint: result.hostKey.fingerprint };
    } catch (err) {
        throw sshFailure(err, target);
    } finally {
        closeEngineSession(sessionId, target);
    }
};

const openTargetSession = async (target, params, { expectedHostKey = null, execOnly = false, signal = null } = {}) => {
    const sessionId = newSessionId();
    let client = null;
    let ended = false;
    const close = () => {
        client?.close();
        if (ended) return;
        ended = true;
        signal?.removeEventListener("abort", close);
        closeEngineSession(sessionId, target);
    };
    signal?.addEventListener("abort", close, { once: true });
    try {
        if (signal?.aborted) throw new VaultError(VaultErrorCode.CLIENT_GONE);
        const socket = await openEngineSession(sessionId, SessionType.SFTP, target.host, target.port, params,
            target.jumpHosts, target.engineId, { expectedHostKey, execOnly });
        client = new EngineSftpClient(socket);
        await client.waitForReady();
        if (signal?.aborted) throw new VaultError(VaultErrorCode.CLIENT_GONE);
        return { client, close, ref: target.ref };
    } catch (err) {
        close();
        if (err?.errorCode === "HostKeyMismatch") throw hostKeyChanged(target.ref, expectedHostKey, err.hostKey?.fingerprint ?? "none");
        throw sshFailure(err, target, signal);
    }
};

const sshParams = (item, { privateKey = null, passphrase = null, password = null }) => ({
    username: item.fields?.username ?? "",
    ...(password && { password }),
    ...(privateKey && { privateKey }),
    ...(passphrase && { passphrase }),
});

const openAgentServerSession = async (ctx, { signal = null } = {}) => {
    const noServer = () => new VaultError(VaultErrorCode.NO_AGENT_SERVER);
    if (!ctx.agent?.entryId || ctx.keyId == null) throw noServer();
    const key = await ApiKey.findByPk(ctx.keyId);
    if (!key || key.entryId !== ctx.agent.entryId || !key.identityId || !key.remoteUser) throw noServer();
    const entry = await Entry.findByPk(key.entryId);
    if (entry?.type !== "server" || !entry.config?.ip || !(await validateEntryAccess(ctx.accountId, entry)).valid) throw noServer();
    const { host, port, params } = await resolveFileTransferContext(entry, key.identityId, null, ctx.accountId)
        .catch(() => { throw noServer(); });
    if (params.username !== key.remoteUser) throw noServer();
    const server = {
        ref: `server:${entry.id}`, kind: "server", name: entry.name, host, port: Number(port) || 22,
        jumpHosts: await resolveJumpHosts(entry).catch(() => { throw noServer(); }), engineId: entry.config.engineId ?? null,
    };
    assertEngine(server);
    return { ...(await openTargetSession(server, params, { signal })), user: params.username };
};

module.exports = {
    resolveTarget, assertEngine, probeHostKey, openTargetSession, openAgentServerSession, sshParams, sshFailure, hostKeyChanged,
};

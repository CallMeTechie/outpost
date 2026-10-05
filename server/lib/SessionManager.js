const fs = require("node:fs");
const { v4: uuidv4 } = require("uuid");
const logger = require("../utils/logger");
const AuditLog = require("../models/AuditLog");
const { isRecordingEnabled, getRecordingPath, compressRecording } = require("../utils/recordingService");
const stateBroadcaster = require("./StateBroadcaster");

const MAX_LOG_BUFFER_SIZE = 200 * 1024;
const sessions = new Map();
const shareIndex = new Map();
const CONTROL_PLANE_TYPES = new Set(["ssh", "telnet", "sftp", "guac", "pve-lxc"]);

const TYPING_DURATION_MS = 1500;
const PRESENCE_THROTTLE_MS = 250;
const CLOSE_GRACE_MS = 1000;
const TOMBSTONE_TTL_MS = 15 * 60 * 1000;
const RETIRABLE_PROTOCOLS = new Set(["ssh", "telnet", "pve-lxc", "rdp", "vnc"]);
// guacd ended it on purpose: session conflict, session timeout, logoff (0x0209-0x020B), or a 0x03xx client error.
const FINAL_GUAC_STATUSES = new Set([0x0209, 0x020A, 0x020B]);
const ENGINE_SESSION_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([1-9][0-9]{0,8}))?$/;
const retired = new Map();

const engineSessionIdFor = (sessionId, generation) => (generation === 1 ? sessionId : `${sessionId}:${generation}`);

const isCurrentGeneration = (session, generation, action) => {
    if (generation === undefined || session.generation === generation) return true;
    logger.info(`Ignoring ${action} for an older generation`, { sessionId: session.sessionId, generation, current: session.generation });
    return false;
};

module.exports.CLOSE_GRACE_MS = CLOSE_GRACE_MS;
module.exports.TOMBSTONE_TTL_MS = TOMBSTONE_TTL_MS;

module.exports.resolveEngineSession = (engineSessionId) => {
    const match = ENGINE_SESSION_ID.exec(String(engineSessionId ?? ""));
    if (!match) return null;
    return { sessionId: match[1], generation: match[2] ? Number(match[2]) : 1 };
};

module.exports.create = (accountId, entryId, configuration, connectionReason = null, tabId = null, browserId = null, auditLogId = null, organizationId = null, { sessionId = uuidv4(), generation = 1 } = {}) => {
    if (sessions.has(sessionId)) throw new Error("Session id is still in use");
    const session = {
        sessionId, generation, engineSessionId: engineSessionIdFor(sessionId, generation),
        accountId, entryId, configuration, connectionReason,
        tabId, browserId, auditLogId, organizationId,
        isHibernated: false,
        createdAt: new Date(),
        lastActivity: new Date(),
        masterConnection: null,
        logBuffer: "",
        activeWs: null,
        connectedWs: new Set(),
        sharedWs: new Set(),
        participants: new Map(),
        shareId: null,
        shareWritable: false,
        _closeGrace: null,
    };
    sessions.set(sessionId, session);
    logger.info(`Session created`, { sessionId, generation, accountId, entryId, organizationId });
    return session;
};

module.exports.get = (sessionId) => sessions.get(sessionId) || null;

module.exports.isCurrent = (sessionId, generation, action) => {
    const session = module.exports.get(sessionId);
    return Boolean(session) && isCurrentGeneration(session, generation, action);
};

module.exports.isEnding = (sessionId) => {
    const session = module.exports.get(sessionId);
    return Boolean(session?._removing || session?._closeGrace);
};

module.exports.getAll = (accountId, tabId = undefined, browserId = undefined) => {
    const results = [];
    for (const session of sessions.values()) {
        if (session.accountId !== accountId) continue;
        if (session.isHibernated) {
            results.push(session);
            continue;
        }
        if (tabId !== undefined && session.tabId !== tabId) continue;
        if (browserId !== undefined && session.browserId !== browserId) continue;
        results.push(session);
    }
    return results;
};

const sessionsOfOrganization = function* (organizationId) {
    const numericOrgId = Number(organizationId);
    for (const session of sessions.values()) {
        if (Number(session.organizationId) === numericOrgId) yield session;
    }
};

module.exports.getOrganizationSessions = (organizationId, excludeAccountId = null) => {
    const results = [];
    for (const session of sessionsOfOrganization(organizationId)) {
        if (session.isHibernated) continue;
        if (excludeAccountId !== null && session.accountId === excludeAccountId) continue;
        results.push(session);
    }
    return results;
};

module.exports.setConnection = (sessionId, connection, generation) => {
    const session = module.exports.get(sessionId);
    if (!session || !isCurrentGeneration(session, generation, "setConnection")) return false;
    if (session.masterConnection) {
        logger.warn(`Session already has master connection`, { sessionId });
        return false;
    }
    session.masterConnection = connection;
    return true;
};

module.exports.setGuacReady = (sessionId) => {
    const session = module.exports.get(sessionId);
    if (!session) return;
    session.guacReady = true;
    if (session._guacReadyWaiters) {
        for (const resolve of session._guacReadyWaiters) resolve();
        delete session._guacReadyWaiters;
    }
};

module.exports.waitForGuacReady = (sessionId, timeoutMs = 30000) => {
    const session = module.exports.get(sessionId);
    if (!session) return Promise.reject(new Error("Session not found"));
    if (session.guacReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Guac ready timeout")), timeoutMs);
        if (!session._guacReadyWaiters) session._guacReadyWaiters = [];
        session._guacReadyWaiters.push(() => { clearTimeout(timeout); resolve(); });
    });
};

module.exports.getConnection = (sessionId) => module.exports.get(sessionId)?.masterConnection || null;

module.exports.updateConnectionId = (sessionId, connectionId) => {
    const session = module.exports.get(sessionId);
    if (session?.masterConnection) {
        session.masterConnection.guacdConnectionId = connectionId;
    }
};

const logRemovalError = (sessionId) => (error) => logger.error("Removing session failed", { sessionId, error: error.message });

module.exports.onMasterConnectionClosed = (sessionId, reason = "closed", { guacStatus = null, generation } = {}) => {
    const session = module.exports.get(sessionId);
    if (!session) return;
    logger.info(`Master connection ${reason}, terminating session`, { sessionId });
    if (reason.startsWith("error:")) {
        module.exports.markFailed(sessionId, reason, generation);
        module.exports.remove(sessionId, { code: 4017, reason, guacStatus, generation }).catch(logRemovalError(sessionId));
    } else {
        module.exports.remove(sessionId, { generation }).catch(logRemovalError(sessionId));
    }
};

module.exports.initRecording = async (sessionId, organizationId, { generation, cols = 80, rows = 24 } = {}) => {
    const session = module.exports.get(sessionId);
    if (!session?.auditLogId || !isCurrentGeneration(session, generation, "initRecording")) return false;

    const enabled = await isRecordingEnabled(organizationId);
    if (!enabled || module.exports.get(sessionId) !== session || session._removing) return false;

    const castPath = getRecordingPath(session.auditLogId, "cast", false);
    const stream = fs.createWriteStream(castPath, { flags: "w" });
    const startTime = Date.now();
    stream.write(JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(startTime / 1000), env: { SHELL: "/bin/bash", TERM: "xterm-256color" } }) + "\n");
    session.recording = { stream, startTime, path: castPath, cols, rows };
    logger.info("Recording started", { sessionId, auditLogId: session.auditLogId });
    return true;
};

module.exports.recordResize = (sessionId, cols, rows) => {
    const rec = module.exports.get(sessionId)?.recording;
    if (!rec?.stream || (rec.cols === cols && rec.rows === rows)) return;
    rec.cols = cols;
    rec.rows = rows;
    rec.stream.write(JSON.stringify([(Date.now() - rec.startTime) / 1000, "r", `${cols}x${rows}`]) + "\n");
};

module.exports.appendLog = (sessionId, data) => {
    const session = module.exports.get(sessionId);
    if (!session) return;
    session.logBuffer += data;
    if (session.logBuffer.length > MAX_LOG_BUFFER_SIZE) {
        session.logBuffer = session.logBuffer.slice(-MAX_LOG_BUFFER_SIZE);
    }
    session.recording?.stream?.write(JSON.stringify([(Date.now() - session.recording.startTime) / 1000, "o", data]) + "\n");
};

const markRecordingComplete = async (auditLogId, recordingType) => {
    if (!auditLogId) return;
    const log = await AuditLog.findByPk(auditLogId);
    if (!log) return;
    const details = log.details || {};
    await AuditLog.update({ details: { ...details, hasRecording: true, recordingType } }, { where: { id: auditLogId } });
};

const finalizeTerminalRecording = async (session) => {
    const rec = session.recording;
    if (!rec?.stream) return;
    const { stream, path } = rec;
    session.recording = null;
    stream.end();
    await new Promise(r => stream.on("finish", r));
    await compressRecording(path, getRecordingPath(session.auditLogId, "cast", true));
    await markRecordingComplete(session.auditLogId, "cast");
};

// For a generation that lost the race after its recording started: teardown has already run (or will
// run for a newer object), so nothing else would ever close this stream.
module.exports.finalizeDetachedRecording = (session) => {
    if (sessions.get(session.sessionId) === session) return Promise.resolve();
    return finalizeTerminalRecording(session);
};

module.exports.getLogBuffer = (sessionId) => module.exports.get(sessionId)?.logBuffer || "";

module.exports.setActiveWs = (sessionId, ws) => {
    const session = module.exports.get(sessionId);
    if (session) session.activeWs = ws;
};

module.exports.isActiveWs = (sessionId, ws) => module.exports.get(sessionId)?.activeWs === ws;

module.exports.pinMonitor = (sessionId, ws, monitor) => {
    const session = module.exports.get(sessionId);
    if (!session) return;
    session.pinnedMonitors ??= new Map();
    session.pinnedMonitors.set(ws, monitor);
};

module.exports.unpinMonitor = (sessionId, ws) => {
    module.exports.get(sessionId)?.pinnedMonitors?.delete(ws);
};

module.exports.isMonitorPinnedByOther = (sessionId, ws, monitor) => {
    for (const [pinnedWs, pinnedMonitor] of module.exports.get(sessionId)?.pinnedMonitors ?? [])
        if (pinnedWs !== ws && pinnedMonitor === monitor) return true;

    return false;
};

const collectParticipants = (session) => {
    const now = Date.now();
    const byKey = new Map();
    for (const participant of session.participants.values()) {
        const key = participant.accountId ? `a:${participant.accountId}` : `w:${participant.viewerId}`;
        const typing = participant.typingUntil > now;
        const existing = byKey.get(key);
        if (existing) {
            existing.typing ||= typing;
            existing.writable ||= participant.writable;
            continue;
        }
        byKey.set(key, {
            viewerId: participant.viewerId,
            accountId: participant.accountId,
            username: participant.username,
            firstName: participant.firstName,
            lastName: participant.lastName,
            avatarHash: participant.avatarHash,
            kind: participant.kind,
            writable: participant.writable,
            typing,
        });
    }
    return [...byKey.values()];
};

module.exports.getParticipants = (sessionId) => {
    const session = module.exports.get(sessionId);
    return session ? collectParticipants(session) : [];
};

const emitPresence = (session) => {
    const participants = collectParticipants(session);
    const accountIds = new Set([session.accountId, ...participants.map(p => p.accountId).filter(Boolean)]);
    stateBroadcaster.push([...accountIds], "SESSION_PRESENCE", { sessionId: session.sessionId, participants });
};

const schedulePresence = (session, immediate = false) => {
    if (immediate) {
        if (session._presenceTimer) {
            clearTimeout(session._presenceTimer);
            session._presenceTimer = null;
        }
        emitPresence(session);
        return;
    }
    if (session._presenceTimer) return;
    session._presenceTimer = setTimeout(() => {
        session._presenceTimer = null;
        if (sessions.has(session.sessionId)) emitPresence(session);
    }, PRESENCE_THROTTLE_MS);
};

module.exports.markTyping = (sessionId, ws) => {
    const session = module.exports.get(sessionId);
    const participant = session?.participants.get(ws);
    if (!participant) return;
    const wasTyping = participant.typingUntil > Date.now();
    participant.typingUntil = Date.now() + TYPING_DURATION_MS;
    if (!wasTyping) schedulePresence(session);

    clearTimeout(participant.typingTimer);
    participant.typingTimer = setTimeout(() => {
        if (sessions.has(sessionId)) schedulePresence(session, true);
    }, TYPING_DURATION_MS + 50);
};

module.exports.addWebSocket = (sessionId, ws, isShared = false, participant = null) => {
    const session = module.exports.get(sessionId);
    if (!session) return;
    if (isShared) session.sharedWs.add(ws);
    else session.connectedWs.add(ws);

    if (participant) {
        session.participants.set(ws, {
            viewerId: uuidv4(),
            accountId: participant.accountId || null,
            username: participant.username || null,
            firstName: participant.firstName || null,
            lastName: participant.lastName || null,
            avatarHash: participant.avatarHash || null,
            kind: participant.kind || (isShared ? "link" : "owner"),
            writable: participant.writable !== false,
            typingUntil: 0,
            typingTimer: null,
        });
        schedulePresence(session, true);
    }
};

module.exports.removeWebSocket = (sessionId, ws, isShared = false) => {
    const session = module.exports.get(sessionId);
    if (!session) return;
    if (isShared) session.sharedWs.delete(ws);
    else session.connectedWs.delete(ws);
    if (session.activeWs === ws) session.activeWs = null;

    const participant = session.participants.get(ws);
    if (participant) {
        clearTimeout(participant.typingTimer);
        session.participants.delete(ws);
        schedulePresence(session, true);
    }
};

const closeAllWebSockets = (sessionId, code = 1000, reason = "Session terminated") => {
    const session = module.exports.get(sessionId);
    if (!session) return;
    const sharedCode = code === 1000 ? 4016 : code;
    for (const ws of session.connectedWs) {
        try { if (ws.readyState <= 1) ws.close(code, reason); } catch {}
    }
    for (const ws of session.sharedWs) {
        try { if (ws.readyState <= 1) ws.close(sharedCode, reason); } catch {}
    }
    session.connectedWs.clear();
    session.sharedWs.clear();
    session.activeWs = null;
};

const FAILED_SESSION_TTL_MS = 30000;
const failedSessions = new Map();

module.exports.markFailed = (sessionId, reason, generation) => {
    const session = sessions.get(sessionId);
    if (session && !isCurrentGeneration(session, generation, "markFailed")) return;
    const existing = failedSessions.get(sessionId);
    if (existing) clearTimeout(existing.timeout);
    const timeout = setTimeout(() => failedSessions.delete(sessionId), FAILED_SESSION_TTL_MS);
    failedSessions.set(sessionId, { reason: reason || "Connection failed", timeout });
};

module.exports.consumeFailedReason = (sessionId) => {
    const entry = failedSessions.get(sessionId);
    if (!entry) return null;
    clearTimeout(entry.timeout);
    failedSessions.delete(sessionId);
    return entry.reason;
};

module.exports.hibernate = (sessionId) => {
    const session = module.exports.get(sessionId);
    if (!session) return false;
    session.isHibernated = true;
    session.lastActivity = new Date();
    logger.info(`Session hibernated`, { sessionId });
    return true;
};

module.exports.resume = (sessionId, tabId = null, browserId = null) => {
    const session = module.exports.get(sessionId);
    if (!session) return false;
    session.isHibernated = false;
    session.lastActivity = new Date();
    if (tabId !== null) session.tabId = tabId;
    if (browserId !== null) session.browserId = browserId;
    logger.info(`Session resumed`, { sessionId });
    return true;
};

const clearCloseGrace = (session) => {
    if (!session._closeGrace) return;
    clearTimeout(session._closeGrace.timer);
    session._closeGrace.resolve();
    session._closeGrace = null;
};

module.exports.beginCloseGrace = (sessionId, generation) => {
    const session = sessions.get(sessionId);
    if (!session || session._removing || session._closeGrace) return;
    if (!isCurrentGeneration(session, generation, "beginCloseGrace")) return;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const timer = setTimeout(() => {
        module.exports.remove(sessionId, { generation: session.generation })
            .catch((error) => logger.error("Removing session after close grace failed", { sessionId, error: error.message }));
    }, CLOSE_GRACE_MS);
    session._closeGrace = { timer, promise, resolve };
};

module.exports.whenEnded = async (sessionId) => {
    for (let session = sessions.get(sessionId); session; session = sessions.get(sessionId)) {
        if (session._removal) await session._removal.catch(() => {});
        else if (session._closeGrace) await session._closeGrace.promise;
        else return;
    }
};

const retire = (session, { code, reason, guacStatus }) => {
    const { protocol, type, scriptId } = session.configuration || {};
    if (code !== 4017 || !RETIRABLE_PROTOCOLS.has(protocol) || type === "sftp" || scriptId != null) return;
    const status = guacStatus == null ? null : Number(guacStatus);
    if (FINAL_GUAC_STATUSES.has(status) || (status >= 0x0300 && status <= 0x03FF)) return;
    retired.set(session.sessionId, {
        accountId: session.accountId,
        organizationId: session.organizationId,
        entryId: session.entryId ?? null,
        directTarget: session.configuration.directTarget ?? null,
        configuration: session.configuration,
        connectionReason: session.connectionReason,
        tabId: session.tabId,
        browserId: session.browserId,
        generation: session.generation,
        reason,
        expiresAt: Date.now() + TOMBSTONE_TTL_MS,
    });
    logger.info("Session retired", { sessionId: session.sessionId, generation: session.generation });
};

module.exports.getTombstone = (sessionId) => {
    const tombstone = retired.get(sessionId);
    if (!tombstone) return null;
    if (tombstone.expiresAt <= Date.now()) {
        retired.delete(sessionId);
        return null;
    }
    return tombstone;
};

module.exports.dropTombstone = (sessionId) => retired.delete(sessionId);

const closeCrossTransferClients = (conn) => {
    for (const entry of conn.crossTransferClients?.values() || []) {
        try { entry.client?.close(); } catch {}
    }
    conn.crossTransferClients?.clear();
};

const cleanupConnection = async (conn, engineSessionId) => {
    if (CONTROL_PLANE_TYPES.has(conn.type)) {
        try { require("./controlPlane/ControlPlaneServer").closeSession(engineSessionId); } catch {}
    }
    for (const s of [conn.dataSocket, conn.socket]) {
        if (!s) continue;
        try { s.removeAllListeners(); } catch {}
        try { s.end(); } catch {}
        try { s.destroy(); } catch {}
    }
    if (conn.keepAliveTimer) clearInterval(conn.keepAliveTimer);
    try { conn.guacdClient?.close(); } catch {}
    try { conn.sftpClient?.close(); } catch {}
    try { conn.transferClient?.close(); } catch {}
    try { conn.backgroundClient?.close(); } catch {}
    try { conn.aiClient?.close(); } catch {}
    closeCrossTransferClients(conn);
    if (CONTROL_PLANE_TYPES.has(conn.type)) {
        for (const auxSessionId of conn.auxSessionIds || []) {
            try { require("./controlPlane/ControlPlaneServer").closeSession(auxSessionId); } catch {}
        }
    }
};

module.exports.remove = (sessionId, options = {}) => {
    const session = module.exports.get(sessionId);
    if (!session || !isCurrentGeneration(session, options.generation, "remove")) return Promise.resolve(false);
    clearCloseGrace(session);
    if (session._removing) return Promise.resolve(false);
    session._removing = true;
    session._removal = teardown(session, options);
    return session._removal;
};

const teardown = async (session, options) => {
    const { sessionId } = session;

    // First, unconditionally, before anything below that can throw: finalizeTerminalRecording and
    // cleanupConnection both await external I/O (compression, a DB write, socket teardown) and
    // neither is wrapped here. If either rejects, this function throws too — and _removing is
    // already true, so every later retry is refused for good (see the guard above). A transfer's
    // registry slot must not depend on those succeeding; it is reserved as soon as a transfer is
    // authorized, before either side even opens its auxiliary connection, so a session can hold a
    // slot without ever having a master connection at all.
    try { require("./fileTransfer/registry").releaseSession(sessionId); } catch {}
    // Same reasoning, same place: a preview token reads files through this session, so it must
    // not outlive it. It would fail on the next request anyway -- validateSession no longer finds
    // the session -- but leaving it in the map until its TTL is a credential with nothing behind
    // it lying around for ten minutes.
    try { require("./fileContent/previewTokens").revokeForSession(sessionId); } catch {}

    const { code = 1000, reason = "Session terminated", guacStatus = null } = options;
    // Everything below can throw (finalizeTerminalRecording awaits compression and a DB write,
    // cleanupConnection awaits socket teardown) — none of it wrapped before this round. Without the
    // finally, a throw here left the session stuck in `sessions` forever: `_removing` is already
    // true, so the guard above refuses every later retry for good, yet the session never actually
    // goes away — still connected to onMasterConnectionClosed, still enumerable by getAll(),
    // wherever anything looks it up (this is exactly what the fix round 1 recording-failure test
    // produces). Keep this narrow: only the removal itself is guaranteed here, not a redesign of
    // what the removal does.
    try {
        closeAllWebSockets(sessionId, code, reason);
        // Captured, not rethrown here: a failing recording finalization must not skip
        // cleanupConnection below it — the master connection and its auxiliary engine sessions
        // would otherwise stay open with no owner left, and both broadcasts after this block would
        // never fire, so a client would keep believing this session is still live. Rethrown at the
        // end of the try (still inside it, so the outer finally below still runs either way) once
        // the rest of the teardown has actually happened, so a caller still learns about the
        // failure — just after everything that does not depend on it already ran.
        let recordingError = null;
        if (session.recording) {
            try { await finalizeTerminalRecording(session); }
            catch (err) { recordingError = err; }
        }
        if (session.masterConnection) {
            await cleanupConnection(session.masterConnection, session.engineSessionId);
            session.masterConnection = null;
        }
        if (session.shareId) shareIndex.delete(session.shareId);

        if (session._presenceTimer) clearTimeout(session._presenceTimer);
        for (const participant of session.participants.values()) clearTimeout(participant.typingTimer);
        session.participants.clear();

        if (recordingError) throw recordingError;
    } finally {
        retire(session, { code, reason, guacStatus });
        sessions.delete(sessionId);
    }

    const { accountId, organizationId } = session;
    logger.info("Session removed", { sessionId });
    stateBroadcaster.broadcast("CONNECTIONS", { accountId });
    if (organizationId) stateBroadcaster.broadcast("LIVE_SESSIONS", { organizationId });
    return true;
};

module.exports.updateActivity = (sessionId) => {
    const session = module.exports.get(sessionId);
    if (session) session.lastActivity = new Date();
};

module.exports.setSftpPath = (sessionId, path) => {
    const session = module.exports.get(sessionId);
    if (!session) return;
    session.sftpPath = path;
    session.lastActivity = new Date();
};

module.exports.getSftpPath = (sessionId) => {
    return module.exports.get(sessionId)?.sftpPath || null;
};

module.exports.startSharing = (sessionId, writable = false) => {
    const session = module.exports.get(sessionId);
    if (!session) return null;
    if (session.shareId) return session.shareId;
    const shareId = uuidv4().replaceAll("-", "").substring(0, 16);
    session.shareId = shareId;
    session.shareWritable = writable;
    shareIndex.set(shareId, sessionId);
    logger.info(`Session sharing started`, { sessionId, shareId, writable });
    return shareId;
};

module.exports.stopSharing = (sessionId) => {
    const session = module.exports.get(sessionId);
    if (!session?.shareId) return false;
    shareIndex.delete(session.shareId);
    for (const ws of session.sharedWs) {
        if (session.activeWs === ws) session.activeWs = null;
        try { ws.close(4016, "Sharing stopped"); } catch {}
    }
    session.sharedWs.clear();
    session.shareId = null;
    session.shareWritable = false;
    logger.info(`Session sharing stopped`, { sessionId });
    return true;
};

module.exports.updateSharePermissions = (sessionId, writable) => {
    const session = module.exports.get(sessionId);
    if (!session?.shareId) return false;
    session.shareWritable = writable;
    for (const participant of session.participants.values()) {
        if (participant.kind === "link") participant.writable = writable;
    }
    schedulePresence(session, true);
    return true;
};

module.exports.disconnectOrganizationViewers = (organizationId, accountId = null) => {
    let disconnected = 0;
    for (const session of sessionsOfOrganization(organizationId)) {
        for (const [ws, participant] of session.participants) {
            if (participant.kind !== "organization") continue;
            if (accountId !== null && participant.accountId !== accountId) continue;
            try { ws.close(4016, "Live session sharing disabled"); } catch {}
            disconnected++;
        }
    }
    if (disconnected > 0) logger.info("Disconnected organization session viewers", { organizationId, disconnected });
    return disconnected;
};

module.exports.getByShareId = (shareId) => {
    const sessionId = shareIndex.get(shareId);
    return sessionId ? module.exports.get(sessionId) : null;
};

// Repeated until nothing is left: a 4017 teardown still running retires its session in its finally,
// and a reconnect in flight can claim that tombstone while later sessions are still being torn down.
const removeAllWhere = async (matchesSession, matchesTombstone) => {
    let count = 0;
    for (;;) {
        for (const [id, tombstone] of retired) if (matchesTombstone(tombstone)) retired.delete(id);
        const toRemove = [...sessions.entries()].filter(([, s]) => matchesSession(s)).map(([id]) => id);
        if (toRemove.length === 0) break;
        for (const id of toRemove) {
            await module.exports.remove(id).catch(logRemovalError(id));
            await module.exports.whenEnded(id);
        }
        count += toRemove.length;
    }
    return count;
};

module.exports.removeAllByAccountId = async (accountId) => {
    const numericId = Number(accountId);
    const count = await removeAllWhere((s) => s.accountId === numericId, (t) => Number(t.accountId) === numericId);
    logger.info(`Removed all sessions for account`, { accountId, count });
    return count;
};

module.exports.removeAllByEntryId = async (entryId) => {
    const numericId = Number(entryId);
    const count = await removeAllWhere((s) => s.entryId === numericId, (t) => Number(t.entryId) === numericId);
    if (count > 0) {
        logger.info(`Removed all sessions for entry`, { entryId, count });
    }
    return count;
};

module.exports.closeCrossTransferClients = closeCrossTransferClients;

// unref() so this timer does not by itself keep a process alive: anything that merely imports
// SessionManager (tests, scripts) must be able to exit. The running server is unaffected — its
// HTTP listener keeps the event loop open anyway. Same pattern as logger.js:23-28.
setInterval(() => {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    let removed = 0;
    for (const [sessionId, session] of sessions) {
        if (!session.isHibernated && new Date(session.lastActivity) < sixHoursAgo) {
            logger.info("Removing old session", { sessionId });
            module.exports.remove(sessionId);
            removed++;
        }
    }
    if (removed > 0) logger.info(`Cleaned up ${removed} old sessions`);
}, 30 * 60 * 1000).unref();

setInterval(() => {
    const now = Date.now();
    for (const [sessionId, tombstone] of retired) if (tombstone.expiresAt <= now) retired.delete(sessionId);
}, 60 * 1000).unref();

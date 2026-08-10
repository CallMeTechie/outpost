const SessionManager = require("./SessionManager");
const GuacdClient = require("./GuacdClient");
const logger = require("../utils/logger");
const { getIdentityCredentials } = require("../controllers/identity");
const { getIntegrationCredentials } = require("../controllers/integration");
const { createTicket, getNodeForServer, openLXCConsole } = require("../controllers/pve");
const Entry = require("../models/Entry");
const Integration = require("../models/Integration");
const { resolveIdentity } = require("../utils/identityResolver");
const { getScript } = require("../controllers/script");
const OrganizationMember = require("../models/OrganizationMember");
const { ScriptLayer } = require("./ScriptLayer");
const { SessionType } = require("./generated/control_plane_generated");
const controlPlane = require("./controlPlane/ControlPlaneServer");
const { isRecordingEnabled } = require("../utils/recordingService");
const EngineSftpClient = require("./EngineSftpClient");
const { buildPveQemuParams, buildRdpParams, buildVncParams, buildDemoParams } = require("./guacParamBuilders");
const { writeAfterSettle } = require("./streamCommandWriter");
const TmuxService = require("./tmux/TmuxService");
const { isValidAttachName, buildAttachLines, isValidWindowId } = require("./tmux/commands");

const GUAC_PROTOCOLS = {
    rdp: { sessionType: SessionType.RDP, defaultPort: 3389 },
    vnc: { sessionType: SessionType.VNC, defaultPort: 5900 },
    "pve-qemu": { sessionType: SessionType.VNC, defaultPort: 5900 },
    demo: { sessionType: SessionType.Demo, defaultPort: 0 },
};

const requireEngine = () => {
    if (!controlPlane.hasEngine()) throw new Error("No engine connected");
};

/**
 * By the time the tmux probe (and, when it created a fresh session, the
 * send-keys calls) have resolved, the shell's MOTD and prompt have long since
 * been written and gone quiet — those round trips to the same host each take
 * far longer than the shell needs to settle. writeAfterSettle's own quiet
 * detection therefore has nothing left to observe here and would otherwise
 * ride out the full default hard cap for no reason. A short cap is enough:
 * it still gives a slow-to-print prompt a moment to finish, without holding
 * up the common case where there is nothing left to wait for.
 */
const TMUX_ATTACH_MAX_WAIT_MS = 300;

/**
 * Cross-pane transfer fix round 3: a cross-transfer connection is opened on demand, against a
 * session the caller does not own and that is often a different host entirely from the one it is
 * already connected to — unlike the primary SFTP connection or an ordinary background/transfer
 * client on the caller's own session, nothing here bounds resolveFileTransferContext's DB and
 * credential lookup, openEngineSession's connect, or EngineSftpClient#waitForReady. That matters
 * specifically for this path: registry.js reserves a cross-transfer slot before this connection is
 * opened, and only a settled promise here lets the transfer's own cleanup ever run to release it —
 * a connection attempt that never settles would hold that slot (and, while shared with a co-waiter
 * at ConnectionService.js's own connectingKey cache, ties up whoever else is waiting on it too)
 * indefinitely. 30s matches the two other connection-adjacent deadlines already in this codebase —
 * EngineSftpClient's own per-request REQUEST_TIMEOUT and ControlPlaneServer's SESSION_TIMEOUT for
 * openSession() — instead of inventing a new number. Deliberately not applied to
 * getAuxiliarySFTPClient's other callers (the primary connection, getSFTPTransferClient,
 * getSFTPBackgroundClient, getSFTPAIClient): those keep working today against a merely slow server,
 * and a blanket deadline would turn "slow" into "broken" for all of them at once.
 */
const CROSS_TRANSFER_CONNECT_TIMEOUT_MS = 30000;

// Races `promise` against a timer; the timer is always cleared once the race settles, whichever
// side wins. Deliberately not unref()'d, matching every other request-deadline timer already in
// this codebase (ControlPlaneServer.js's SESSION_TIMEOUT and DATA_CONNECTION_TIMEOUT, both plain
// setTimeout): a live connection attempt is real pending work, not idle housekeeping, so it should
// count toward keeping the process up during a graceful shutdown like any other in-flight request.
// onTimeout, if given, fires only when the timer itself wins the race — never when `promise`
// settles first, timeout or not — so a caller can tell "the deadline passed" apart from "the
// attempt failed on its own" without inspecting the rejection's message.
const withTimeout = (promise, ms, message, onTimeout) => {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { onTimeout?.(); reject(new Error(message)); }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

class IdentityAccessDeniedError extends Error {
    constructor() {
        super("You don't have access to this identity");
        this.name = "IdentityAccessDeniedError";
    }
}

const requireSession = (sessionId) => {
    const session = SessionManager.get(sessionId);
    if (!session) throw new Error("Session not found");
    return session;
};

const resolveCredentials = async (identity) => {
    return identity.isDirect && identity.directCredentials
        ? identity.directCredentials
        : await getIdentityCredentials(identity.id);
};

const buildSSHParams = (identity, credentials) => {
    const params = { username: identity.username || credentials.username || "" };
    if (credentials.password) params.password = credentials.password;
    if (credentials.privateKey || credentials["ssh-key"]) params.privateKey = credentials.privateKey || credentials["ssh-key"];
    if (credentials.passphrase) params.passphrase = credentials.passphrase;
    return params;
};

const extractIdentity = (identityResult) => {
    return identityResult?.identity === undefined ? identityResult : identityResult.identity;
};

const FILE_TRANSFER_PORTS = { sftp: 22, ftp: 21, ftps: 21 };

const getEntryProtocol = (entry) => (entry.type === "server" ? entry.config?.protocol : entry.type);

const getHostPort = (entry, defaultPort = 22) => {
    const host = entry.config?.ip;
    const port = entry.config?.port || defaultPort;
    if (!host) throw new Error("Missing host configuration");
    return { host, port };
};

const resolveJumpHosts = async (entry) => {
    const jumpHostIds = entry.config?.jumpHosts;
    if (!jumpHostIds || jumpHostIds.length === 0) return [];

    const jumpHosts = [];
    for (const jumpHostId of jumpHostIds) {
        const jhEntry = await Entry.findByPk(jumpHostId);
        if (!jhEntry) throw new Error(`Jump host entry ${jumpHostId} not found`);

        const { host, port } = getHostPort(jhEntry);
        const identityResult = await resolveIdentity(jhEntry, null, null, null);
        const identity = extractIdentity(identityResult);
        if (!identity) throw new Error(`No identity found for jump host ${jumpHostId}`);

        const credentials = await resolveCredentials(identity);
        jumpHosts.push({
            host,
            port,
            username: identity.username || credentials.username || "",
            password: credentials.password || null,
            privateKey: credentials.privateKey || credentials["ssh-key"] || null,
            passphrase: credentials.passphrase || null,
        });
    }
    return jumpHosts;
};

const openEngineSession = async (sessionId, sessionType, host, port, params, jumpHosts = [], engineId) => {
    const dataSocketPromise = controlPlane.waitForDataConnection(sessionId);
    try {
        await controlPlane.openSession(sessionId, sessionType, host, port, params, jumpHosts, engineId || null);
    } catch (err) {
        dataSocketPromise.catch(() => {});
        throw err;
    }
    return dataSocketPromise;
};

const createConnectionForSession = async (sessionId, accountId) => {
    const session = requireSession(sessionId);

    const entry = await Entry.findByPk(session.entryId);
    if (!entry) throw new Error("Entry not found");

    const { type, identityId, directIdentity, scriptId } = session.configuration;
    if (type === "sftp") return { success: true, skipped: true };

    const identityResult = await resolveIdentity(entry, identityId, directIdentity, accountId);
    const identity = extractIdentity(identityResult);
    const organizationId = entry.organizationId || null;
    const protocol = getEntryProtocol(entry);

    let script = null;
    if (scriptId) {
        const memberships = await OrganizationMember.findAll({ where: { accountId } });
        script = await getScript(accountId, scriptId, null, memberships.map(m => m.organizationId));
        if (!script) throw new Error("Script not found");
    }

    switch (protocol) {
        case "ssh": return createSSHConnectionForSession(sessionId, entry, identity, organizationId, script);
        case "telnet": return createTelnetConnectionForSession(sessionId, entry, organizationId);
        case "pve-lxc":
        case "pve-shell": return createPveLxcConnectionForSession(sessionId, entry, organizationId);
        case "pve-qemu":
        case "rdp":
        case "vnc":
        case "demo": return prepareGuacamoleSession(sessionId, entry, identity, organizationId);
        case "sftp":
        case "ftp":
        case "ftps": return { success: true, skipped: true };
        default: throw new Error(`Unsupported protocol: ${protocol}`);
    }
};

const resolveFileTransferContext = async (entry, identityId, directIdentity, accountId) => {
    const identityResult = await resolveIdentity(entry, identityId, directIdentity, accountId);
    // extractIdentity turns { identity: null, accessDenied: true } into plain null, and
    // resolveCredentials(null) then throws a TypeError on identity.isDirect instead of refusing.
    // The same latent bug affects the xfer/bg/ai clients — this fixes it for all of them.
    if (identityResult?.accessDenied) throw new IdentityAccessDeniedError();
    const identity = extractIdentity(identityResult);
    const credentials = await resolveCredentials(identity);
    const protocol = getEntryProtocol(entry);
    const { host, port } = getHostPort(entry, FILE_TRANSFER_PORTS[protocol] ?? 22);
    const params = buildSSHParams(identity, credentials);
    if (protocol) params.protocol = protocol;
    return { identity, credentials, host, port, params };
};

const createSFTPConnectionForSession = async (sessionId, entry, accountId) => {
    const session = requireSession(sessionId);
    if (session.masterConnection?.sftpClient) return { success: true };
    if (session._connecting) return session._connecting;

    session._connecting = (async () => {
        requireEngine();
        const { identityId, directIdentity } = session.configuration;
        const { host, port, params } = await resolveFileTransferContext(entry, identityId, directIdentity, accountId);
        const jumpHosts = await resolveJumpHosts(entry);

        const dataSocket = await openEngineSession(
            sessionId, SessionType.SFTP, host, port, params, jumpHosts, entry.config?.engineId
        );

        const sftpClient = new EngineSftpClient(dataSocket);
        await sftpClient.waitForReady();

        dataSocket.on("close", () => {
            logger.info("SFTP data connection closed", { sessionId });
            SessionManager.remove(sessionId);
        });
        dataSocket.on("error", (err) => {
            logger.error("SFTP data socket error", { sessionId, error: err.message });
            SessionManager.markFailed(sessionId, err.message);
            SessionManager.remove(sessionId, { code: 4017, reason: err.message });
        });

        SessionManager.setConnection(sessionId, {
            sftpClient,
            dataSocket,
            type: "sftp",
            auditLogId: session.auditLogId,
        });

        logger.info("SFTP connected", { sessionId, target: host, port });
        return { success: true };
    })().finally(() => { session._connecting = null; });

    return session._connecting;
};

const getAuxiliarySFTPClient = async (sessionId, entry, accountId, opts) => {
    const { suffix, clientKey, connectingKey, label, onEngineSession, timeoutMs } = opts;
    const session = requireSession(sessionId);
    const conn = SessionManager.getConnection(sessionId);
    if (!conn) throw new Error("No active SFTP session");
    if (conn[clientKey] && !conn[clientKey]._closed) return conn[clientKey];
    // A second caller arriving mid-connect joins the attempt already running instead of opening a
    // second engine session against the same host under the same key — the cap accounts for one.
    if (conn[connectingKey]) return conn[connectingKey];

    const attempt = (async () => {
        requireEngine();
        const { identityId, directIdentity } = session.configuration;
        const { host, port, params } = await resolveFileTransferContext(entry, identityId, directIdentity, accountId);
        const jumpHosts = await resolveJumpHosts(entry);

        conn._auxGeneration = (conn._auxGeneration || 0) + 1;
        const engineSessionId = `${sessionId}-${suffix}-${conn._auxGeneration}`;
        onEngineSession?.(engineSessionId);
        // Registering the id here is what lets SessionManager's cleanupConnection force-close this
        // engine session when the session ends; releaseSFTPCrossTransferClient and
        // evictLateConnection take it back out again once it is closed for good.
        if (!conn.auxSessionIds) conn.auxSessionIds = new Set();
        conn.auxSessionIds.add(engineSessionId);

        const dataSocket = await openEngineSession(
            engineSessionId, SessionType.SFTP, host, port, params, jumpHosts, entry.config?.engineId
        );

        const client = new EngineSftpClient(dataSocket);
        await client.waitForReady();

        const detach = () => { if (conn[clientKey] === client) conn[clientKey] = null; };
        dataSocket.on("close", detach);
        dataSocket.on("error", detach);

        logger.info(`SFTP ${label} connection established`, { sessionId, target: host, port });
        // Caching is deliberately left to connectWithDeadline: whether this connection may be
        // published under clientKey at all depends on whether anyone still wants it, which is
        // only known there.
        return { client, engineSessionId };
    })();

    return connectWithDeadline(conn, clientKey, connectingKey, attempt, timeoutMs, label);
};

// A connection that finished after its caller's deadline had already passed. Nobody is waiting for
// it any more, so it is torn down rather than published: a later, unrelated call reusing the same
// clientKey (registry.js's releaseSession never frees a key early, but the key's own owner will,
// once its transfer actually ends) would otherwise silently inherit a connection opened for a
// different request — possibly a different host entirely, since only the transferId needs to
// repeat, not the entry. Both halves are needed: close() only destroys the socket, the control
// plane has to be told separately (same reason as in releaseSFTPCrossTransferClient) or the engine
// session outlives the attempt. That leak has no cap left to hold it back — the registry slot that
// bounded this connection was released the moment the deadline rejected — so a peer that stalls
// past every deadline and then answers anyway would otherwise open engine sessions without limit.
const evictLateConnection = (conn, client, engineSessionId) => {
    try { client?.close(); } catch {}
    if (!engineSessionId) return;
    try {
        controlPlane.closeSession(engineSessionId);
        // Only once that actually got through: forgetting the id after a failed close would turn a
        // temporary orphan into a permanent one, because the session-end sweep over auxSessionIds
        // is then the last thing that could still reach this engine session — and it can only
        // close ids it can still find.
        conn.auxSessionIds?.delete(engineSessionId);
    } catch {}
};

// Split out of getAuxiliarySFTPClient and exported as a test helper: it only ever touches the
// plain `conn` object and the promise it is given, so a test can drive the deadline path with a
// never-resolving fake `attempt` and a millisecond-scale `timeoutMs` instead of any real I/O.
//
// timeoutMs is only ever set for the cross-transfer path (see CROSS_TRANSFER_CONNECT_TIMEOUT_MS
// above); without it this waits exactly as long as it always has, for every other caller.
const connectWithDeadline = (conn, clientKey, connectingKey, attempt, timeoutMs, label) => {
    // attempt cannot actually be cancelled — the underlying connect keeps running even after the
    // caller gives up on it. Publishing is therefore decided here, once it finishes, and never
    // inside the attempt itself: past the deadline the clientKey may legitimately belong to a
    // later, unrelated call by now, and overwriting it (even to null it again a line further on)
    // would destroy bookkeeping this attempt does not own. What it does own — its own client and
    // its own engine session, and nothing else — is what gets cleaned up instead.
    let timedOut = false;
    const publish = attempt.then(({ client, engineSessionId }) => {
        if (timedOut) evictLateConnection(conn, client, engineSessionId);
        else conn[clientKey] = client;
        return client;
    });

    if (!timeoutMs) {
        conn[connectingKey] = publish.finally(() => { conn[connectingKey] = null; });
        return conn[connectingKey];
    }

    // The timeout wraps the whole shared `conn[connectingKey]` promise, not just a piece of it, so
    // a concurrent co-waiter sharing this same in-flight attempt is bounded by the same deadline.
    conn[connectingKey] = withTimeout(publish, timeoutMs, `Timed out opening ${label} connection`, () => { timedOut = true; })
        .finally(() => { conn[connectingKey] = null; });

    return conn[connectingKey];
};

const getSFTPTransferClient = (sessionId, entry, accountId) =>
    getAuxiliarySFTPClient(sessionId, entry, accountId, {
        suffix: "xfer", clientKey: "transferClient", connectingKey: "_transferConnecting", label: "transfer",
    });

const crossTransferKeys = (transferId) => ({
    suffix: "cxfer",
    clientKey: `crossTransferClient:${transferId}`,
    connectingKey: `_crossTransferConnecting:${transferId}`,
    label: "cross-transfer",
    timeoutMs: CROSS_TRANSFER_CONNECT_TIMEOUT_MS,
});

// One client per transfer: EngineSftpClient multiplexes over request IDs, and close() rejects
// every pending request. A shared client would tear down a foreign transfer on cancel.
const getSFTPCrossTransferClient = async (sessionId, entry, accountId, transferId) => {
    const conn = SessionManager.getConnection(sessionId);
    if (!conn) throw new Error("No active SFTP session");
    if (!conn.crossTransferClients) conn.crossTransferClients = new Map();

    const keys = crossTransferKeys(transferId);
    let engineSessionId = null;
    const client = await getAuxiliarySFTPClient(sessionId, entry, accountId, {
        ...keys,
        onEngineSession: (id) => { engineSessionId = id; },
    });

    // getAuxiliarySFTPClient only calls onEngineSession while it is actually opening a fresh
    // engine session. When it instead serves an already-open client (or another caller is
    // concurrently mid-connect for the same transferId) that callback never fires, so fall back
    // to whatever engineSessionId bookkeeping already has — otherwise a cache hit would stomp a
    // correct entry with null and release() would then skip the control-plane cleanup entirely.
    if (!engineSessionId) engineSessionId = conn.crossTransferClients.get(transferId)?.engineSessionId ?? null;

    conn.crossTransferClients.set(transferId, { client, engineSessionId, clientKey: keys.clientKey });
    return client;
};

const releaseSFTPCrossTransferClient = (conn, transferId) => {
    if (!conn) return;
    // Before the bail-out below, not after it: getAuxiliarySFTPClient parks a per-transfer
    // connectingKey on the connection and only nulls it in its finally, and a connect that failed
    // or ran out its deadline never gets as far as a crossTransferClients entry. Releasing only
    // when there is an entry would leave that dead property behind for the life of the session,
    // once per failed transfer.
    delete conn[crossTransferKeys(transferId).connectingKey];

    const entry = conn.crossTransferClients?.get(transferId);
    if (!entry) return;

    try { entry.client?.close(); } catch {}
    // close() only destroys the socket; the control plane has to be told separately — otherwise
    // the engine session survives until the master session ends.
    if (entry.engineSessionId) {
        try {
            controlPlane.closeSession(entry.engineSessionId);
            // Same reasoning as in evictLateConnection: an id dropped from the connection after a
            // failed close can never be swept at session end either.
            conn.auxSessionIds?.delete(entry.engineSessionId);
        } catch {}
    }
    // detach() only sets conn[clientKey] = null, so without delete a dead property piles up.
    delete conn[entry.clientKey];
    conn.crossTransferClients.delete(transferId);
};

const getSFTPBackgroundClient = (sessionId, entry, accountId) =>
    getAuxiliarySFTPClient(sessionId, entry, accountId, {
        suffix: "bg", clientKey: "backgroundClient", connectingKey: "_backgroundConnecting", label: "background",
    });

const getSFTPAIClient = (sessionId, entry, accountId) =>
    getAuxiliarySFTPClient(sessionId, entry, accountId, {
        suffix: "ai", clientKey: "aiClient", connectingKey: "_aiConnecting", label: "ai",
    });

const getSessionPassword = async (sessionId, entry, accountId) => {
    const session = requireSession(sessionId);
    const { identityId, directIdentity } = session.configuration;
    const { params } = await resolveFileTransferContext(entry, identityId, directIdentity, accountId);
    return params.password || null;
};

const createSSHConnectionForSession = async (sessionId, entry, identity, organizationId, script = null) => {
    const session = requireSession(sessionId);
    if (session._connecting) return session._connecting;

    session._connecting = (async () => {
        requireEngine();
        const credentials = await resolveCredentials(identity);
        const { host, port } = getHostPort(entry);
        const params = buildSSHParams(identity, credentials);
        const jumpHosts = await resolveJumpHosts(entry);

        const dataSocket = await openEngineSession(
            sessionId, SessionType.SSH, host, port, params, jumpHosts, entry.config?.engineId
        );

        await SessionManager.initRecording(sessionId, organizationId);

        dataSocket.on("data", (data) => SessionManager.appendLog(sessionId, data.toString()));
        dataSocket.on("close", () => {
            logger.info("SSH data connection closed", { sessionId });
            SessionManager.remove(sessionId);
        });
        dataSocket.on("error", (err) => {
            logger.error("SSH data socket error", { sessionId, error: err.message });
            SessionManager.markFailed(sessionId, err.message);
            SessionManager.remove(sessionId, { code: 4017, reason: err.message });
        });

        let scriptLayer = null;
        if (script) {
            scriptLayer = new ScriptLayer(dataSocket, null, script, sessionId);
            scriptLayer.start();
        }

        SessionManager.setConnection(sessionId, {
            dataSocket,
            sessionId,
            type: "ssh",
            auditLogId: session.auditLogId,
            scriptLayer,
        });

        if (!script) {
            const startPath = session.configuration.startPath;
            const initialCommand = entry.config?.initialCommand;
            const clean = (value) => {
                if (!value) return null;
                const raw = String(value);
                if (/[\r\n\x00]/.test(raw)) return null;
                return raw;
            };
            const cleanStartPath = clean(startPath);
            const cleanInitialCommand = clean(initialCommand);
            if (startPath && !cleanStartPath) logger.warn("Ignoring startPath containing control characters", { sessionId });
            if (initialCommand && !cleanInitialCommand) logger.warn("Ignoring initialCommand containing control characters", { sessionId });

            const tmuxSession = session.configuration.tmuxSession;

            if (tmuxSession && isValidAttachName(tmuxSession)) {
                const target = { host, port, params, jumpHosts, engineId: entry.config?.engineId ?? null };

                const tmuxStartedAt = Date.now();
                let created = false;
                try {
                    created = await TmuxService.probeSession(target, tmuxSession);
                } catch (error) {
                    logger.warn("tmux probe failed, attaching anyway", { sessionId, error: error.message });
                }

                if (created) {
                    // send-keys only ever targets a session this very flow created with -d.
                    // Against an existing session the command would land in whatever the
                    // user is running there.
                    try {
                        if (cleanStartPath) await TmuxService.sendKeys(target, tmuxSession, `cd '${cleanStartPath.replace(/'/g, `'\\''`)}'`);
                        if (cleanInitialCommand) await TmuxService.sendKeys(target, tmuxSession, cleanInitialCommand);
                    } catch (error) {
                        logger.warn("tmux send-keys failed", { sessionId, error: error.message });
                    }
                }

                // The write must stay ordered after the probe/send-keys calls above:
                // writing the attach command any earlier would let the interactive
                // shell's own `tmux new -A` race the probe's `tmux new-session -d` on
                // the host, which could make the session creation be attributed to the
                // wrong side and skip send-keys entirely. So this keeps a short,
                // fixed-cap settle-wait after those awaits rather than starting it
                // before them.
                logger.debug("tmux attach prepared", {
                    sessionId, created, prepareMs: Date.now() - tmuxStartedAt,
                });
                // An optional leading select-window lets the user land in the
                // window they picked. Two entries instead of one line joined
                // with ";" - writeAfterSettle takes an array anyway. If the
                // first command fails because the window is gone by now, the
                // attach still runs: the user then lands in the session's
                // current window instead of nowhere at all.
                const tmuxWindowId = session.configuration.tmuxWindowId;
                if (tmuxWindowId && !isValidWindowId(tmuxWindowId)) {
                    logger.warn("Ignoring invalid tmux window id", { sessionId });
                }

                void writeAfterSettle(dataSocket, buildAttachLines(tmuxSession, tmuxWindowId),
                    { maxWaitMs: TMUX_ATTACH_MAX_WAIT_MS, label: "tmux-attach" });
            } else {
                if (tmuxSession) logger.warn("Ignoring invalid tmux session name", { sessionId });

                const lines = [];
                if (cleanStartPath) lines.push(`cd '${cleanStartPath.replace(/'/g, `'\\''`)}'`);
                if (cleanInitialCommand) lines.push(cleanInitialCommand);
                if (lines.length) void writeAfterSettle(dataSocket, lines, { label: "shell-commands" });
            }
        }

        logger.info("SSH connected", { sessionId, target: host, port });
        return { success: true };
    })().finally(() => { session._connecting = null; });

    return session._connecting;
};

const createTelnetConnectionForSession = async (sessionId, entry, organizationId) => {
    requireEngine();
    const session = requireSession(sessionId);
    const { ip, port = 23 } = entry.config || {};

    if (!ip) throw new Error("Missing host configuration");

    const dataSocket = await openEngineSession(
        sessionId, SessionType.Telnet, ip, port, {}, entry.config?.engineId
    );

    await SessionManager.initRecording(sessionId, organizationId);

    dataSocket.on("data", (data) => SessionManager.appendLog(sessionId, data.toString()));
    dataSocket.on("close", () => {
        logger.info("Telnet data connection closed", { sessionId });
        SessionManager.remove(sessionId);
    });
    dataSocket.on("error", (err) => {
        logger.error("Telnet data socket error", { sessionId, error: err.message });
        SessionManager.markFailed(sessionId, err.message);
        SessionManager.remove(sessionId, { code: 4017, reason: err.message });
    });

    SessionManager.setConnection(sessionId, {
        dataSocket,
        sessionId,
        type: "telnet",
        auditLogId: session.auditLogId,
    });

    logger.info("Telnet connected", { sessionId, ip, port });
    return { success: true };
}

const createPveLxcConnectionForSession = async (sessionId, entry, organizationId) => {
    requireEngine();
    const session = requireSession(sessionId);

    const integration = entry.integrationId ? await Integration.findByPk(entry.integrationId) : null;
    if (!integration) throw new Error("Integration not found for PVE entry");

    const vmid = entry.config?.vmid ?? "0";
    const integrationCreds = await getIntegrationCredentials(integration.id);
    const server = { ...integration.config, ...entry.config, password: integrationCreds.password };
    const ticket = await createTicket({ ip: server.ip, port: server.port }, server.username, server.password);
    const node = await getNodeForServer(server, ticket);
    const vncTicket = await openLXCConsole({ ip: server.ip, port: server.port }, node, vmid, ticket);

    const containerPart = vmid === 0 || vmid === "0" ? "" : `lxc/${vmid}`;
    const wsUrl = `wss://${server.ip}:${server.port}/api2/json/nodes/${node}/${containerPart}/vncwebsocket?port=${vncTicket.port}&vncticket=${encodeURIComponent(vncTicket.ticket)}`;

    const params = {
        ws_url: wsUrl,
        ws_insecure: "true",
        ws_header_Cookie: `PVEAuthCookie=${ticket.ticket}`,
    };

    const dataSocket = await openEngineSession(
        sessionId, SessionType.WebSocket, server.ip, Number(server.port) || 8006, params, [], entry.config?.engineId
    );

    dataSocket.write(`${server.username}:${vncTicket.ticket}\n`);

    await SessionManager.initRecording(sessionId, organizationId);

    const keepAliveTimer = setInterval(() => {
        if (!dataSocket.destroyed) dataSocket.write("2");
    }, 30000);

    dataSocket.on("data", (data) => {
        const text = data.toString();
        if (text !== "OK") SessionManager.appendLog(sessionId, text);
    });

    dataSocket.on("close", () => {
        clearInterval(keepAliveTimer);
        SessionManager.remove(sessionId);
    });

    dataSocket.on("error", (err) => {
        clearInterval(keepAliveTimer);
        logger.error("PVE LXC data socket error", { sessionId, error: err.message });
        SessionManager.markFailed(sessionId, err.message);
        SessionManager.remove(sessionId, { code: 4017, reason: err.message });
    });

    SessionManager.setConnection(sessionId, {
        dataSocket,
        keepAliveTimer,
        type: "pve-lxc",
        auditLogId: session.auditLogId,
    });

    logger.info("PVE LXC connected via engine", { sessionId, vmid });
    return { success: true };
}

const prepareGuacamoleSession = async (sessionId, entry, identity, organizationId) => {
    const session = requireSession(sessionId);
    requireEngine();
    const protocol = entry.type === "server" ? entry.config?.protocol : entry.type;
    const cfg = entry.config || {};

    let params;
    if (entry.type === "pve-qemu") {
        params = await buildPveQemuParams(entry);
    } else if (protocol === "rdp") {
        params = await buildRdpParams(cfg, identity, session.accountId);
    } else if (protocol === "vnc") {
        params = await buildVncParams(cfg, identity);
    } else if (protocol === "demo") {
        params = await buildDemoParams();
    } else {
        throw new Error(`Unsupported protocol: ${protocol}`);
    }

    const { sessionType, defaultPort } = GUAC_PROTOCOLS[protocol] ?? GUAC_PROTOCOLS.vnc;
    const host = params.hostname || cfg.ip || "";
    const port = Number.parseInt(params.port || cfg.port || defaultPort, 10);
    const jumpHosts = await resolveJumpHosts(entry);

    const dataSocket = await openEngineSession(
        sessionId, sessionType, host, port, params, jumpHosts, entry.config?.engineId
    );

    const recordingEnabled = await isRecordingEnabled(organizationId);

    if (recordingEnabled && session.auditLogId) {
        controlPlane.registerRecordingSession(sessionId, session.auditLogId);
    }

    const masterClient = new GuacdClient({
        sessionId,
        connectionSettings: {
            connection: { type: protocol, width: 1024, height: 768, dpi: 96, ...params },
            enableAudio: entry.config?.enableAudio !== false,
        },
        recordingEnabled,
        auditLogId: session.auditLogId,
        existingSocket: dataSocket,
    });

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Master handshake timeout")), 15000);
        masterClient.onReadyCallback = (connectionId) => { clearTimeout(timeout); resolve(connectionId); };
        masterClient.onCloseCallback = (reason) => { clearTimeout(timeout); reject(new Error(`Master connection failed: ${reason}`)); };
        masterClient.connect();
    });

    SessionManager.setGuacReady(sessionId);

    SessionManager.setConnection(sessionId, {
        guacdClient: masterClient,
        dataSocket,
        type: "guac",
        auditLogId: session.auditLogId,
    });

    logger.info("Guacamole session prepared", { sessionId, protocol, target: host, port });
    return { success: true };
}

module.exports = {
    createConnectionForSession,
    createSFTPConnectionForSession,
    getSFTPTransferClient,
    getSFTPBackgroundClient,
    getSFTPAIClient,
    crossTransferKeys,
    getSFTPCrossTransferClient,
    releaseSFTPCrossTransferClient,
    getSessionPassword,
    buildSSHParams,
    resolveJumpHosts,
    IdentityAccessDeniedError,
    CROSS_TRANSFER_CONNECT_TIMEOUT_MS,
    // Test helpers (fix round 3): pure-ish timing primitives, exported so their deadline behavior
    // can be pinned with millisecond-scale fake attempts instead of any real connection.
    withTimeout,
    connectWithDeadline,
};

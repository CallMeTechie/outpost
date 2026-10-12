const { createHash } = require("node:crypto");
const bed = require("./vaultBed");

const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const world = { engine: true, machines: new Map(), opened: [], closed: [], logins: [], execs: [], pinned: new Map() };
const fp = (name) => `SHA256:${createHash("sha256").update(name).digest("base64").replace(/=+$/, "")}`;
const machine = (name, overrides = {}) => ({
    name, algorithm: "ssh-ed25519", fingerprint: fp(name), accepts: () => true,
    run: (command) => ({ stdout: `${name}: ${command}`, stderr: "", exitCode: 0, timedOut: false }),
    ...overrides,
});
const pinKeyOf = (itemId, ref) => `${itemId} ${ref}`;

class FakeSftpClient {
    constructor(socket) {
        this.machine = socket.machine;
    }

    waitForReady() {
        return Promise.resolve();
    }

    close() {
        this.closed = true;
        this.onClose?.(new Error("Connection closed"));
    }

    exec(command, timeoutMs) {
        world.execs.push({ machine: this.machine.name, command, timeoutMs });
        return Promise.race([this.machine.run(command), new Promise((_, reject) => { this.onClose = reject; })]);
    }
}
fake("../../../EngineSftpClient", FakeSftpClient);
fake("../../../../controllers/entry", {
    resolveEntryScope: async (entry) => ({ organizationId: entry.organizationId ?? null, ownerAccountId: entry.accountId ?? null }),
    validateEntryAccess: async (accountId, entry, message, permission) =>
        ((entry.organizationId ? true : entry.accountId === accountId) && (!permission || bed.state.permissions.has(permission))
            ? { valid: true, entry } : { code: 403, message: "denied" }),
});

const controlPlane = require("../../../controlPlane/ControlPlaneServer");
const dataSockets = new Map();
const failure = (message, errorCode, hostKey = null) => Object.assign(new Error(message), { errorCode, hostKey });
Object.assign(controlPlane, {
    hasEngine: () => world.engine,
    getEngineInfo: (engineId) => (world.engine ? { engineId: String(engineId) } : null),
    closeSession: (sessionId) => {
        world.closed.push(sessionId);
    },
    waitForDataConnection: (sessionId) => new Promise((resolve) => {
        dataSockets.set(sessionId, resolve);
    }),
    openSession: async (sessionId, sessionType, host, port, params = {}, _jumpHosts = [], engineId = null, options = {}) => {
        world.opened.push({ sessionId, sessionType, host, port, params: { ...params }, engineId, options: { ...options } });
        const target = world.machines.get(`${host}:${port}`);
        if (!target) throw failure("Connection refused", "ConnectionFailed");
        const hostKey = { algorithm: target.algorithm, fingerprint: target.fingerprint };
        if (options.probeHostKey) return { success: true, sessionId, hostKey };
        if (options.expectedHostKey && options.expectedHostKey !== target.fingerprint) throw failure("Host key mismatch", "HostKeyMismatch", hostKey);
        if (!target.accepts(params)) throw failure("Authentication failed", "AuthFailed", hostKey);
        world.logins.push({ machine: target.name, username: params.username, expectedHostKey: options.expectedHostKey ?? null });
        dataSockets.get(sessionId)?.({ machine: target });
        return { success: true, sessionId, hostKey };
    },
});

const realTargets = require("../../sshTargets");
fake("../../sshTargets", {
    ...realTargets,
    pinnedKey: async (itemId, ref) => world.pinned.get(pinKeyOf(itemId, ref)) ?? null,
    pinnedRefs: async (itemIds) => new Set([...world.pinned.keys()].filter((key) => itemIds.includes(Number(key.split(" ")[0])))),
    pinKey: async ({ itemId, ref, algorithm, fingerprint, accountId }) => {
        const key = pinKeyOf(itemId, ref);
        if (!world.pinned.has(key)) world.pinned.set(key, { algorithm, fingerprint, confirmedBy: accountId, confirmedAt: new Date() });
        return world.pinned.get(key);
    },
    forgetKey: async (itemId, ref) => world.pinned.delete(pinKeyOf(itemId, ref)),
});

const reset = ({ machines = {}, pinned = [] } = {}) => {
    Object.assign(world, {
        engine: true, machines: new Map(Object.entries(machines)), opened: [], closed: [], logins: [], execs: [],
        pinned: new Map(pinned.map(([itemId, ref, name]) =>
            [pinKeyOf(itemId, ref), { algorithm: "ssh-ed25519", fingerprint: fp(name), confirmedBy: 1, confirmedAt: new Date(0) }])),
    });
    dataSockets.clear();
};

module.exports = {
    world, fp, machine, reset,
    pinned: (itemId, ref) => world.pinned.get(pinKeyOf(itemId, ref)) ?? null,
    forget: (itemId, ref) => world.pinned.delete(pinKeyOf(itemId, ref)),
};

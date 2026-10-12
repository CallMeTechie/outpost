const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { finished } = require("node:stream/promises");
const bed = require("./vaultBed");

const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const TYPE_MASK = 0o170000;
const DIRECTORY = 0o040000;

const world = { engine: true, machines: new Map(), opened: [], closed: [], logins: [], execs: [], pinned: new Map(), ops: [], reads: [], stats: [] };
const fp = (name) => `SHA256:${createHash("sha256").update(name).digest("base64").replace(/=+$/, "")}`;
const machine = (name, overrides = {}) => ({
    name, algorithm: "ssh-ed25519", fingerprint: fp(name), accepts: () => true,
    run: (command) => ({ stdout: `${name}: ${command}`, stderr: "", exitCode: 0, timedOut: false }),
    home: `/home/${name}`, files: new Map(), writable: () => true, setsMode: () => true,
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

    record(op, ...args) {
        world.ops.push([op, this.machine.name, ...args]);
    }

    follow(path) {
        let current = path;
        while (this.machine.files.get(current)?.link) current = this.machine.files.get(current).link;
        return current;
    }

    entry(path) {
        const file = this.machine.files.get(this.follow(path));
        if (!file) throw new Error("Path does not exist");
        return file;
    }

    async realpath(path) {
        return { path: path === "." ? this.machine.home : path, isDirectory: path === "." };
    }

    async stat(path, { owner = true } = {}) {
        world.stats.push([this.machine.name, path, owner]);
        const file = this.entry(path);
        return { size: file.data.length, mode: file.mode, isDir: (file.mode & TYPE_MASK) === DIRECTORY };
    }

    async unlink(path) {
        if (!this.machine.files.delete(path)) throw new Error("Path does not exist");
        this.record("unlink", path);
    }

    async rename(from, to) {
        if (!this.machine.files.has(from) || this.machine.files.has(to)) throw new Error("Operation failed");
        this.machine.files.set(to, this.machine.files.get(from));
        this.machine.files.delete(from);
        this.record("rename", from, to);
    }

    async writeFile(path, source, { exclusive = false, finalMode = 0 } = {}) {
        if (exclusive && this.machine.files.has(path)) throw Object.assign(new Error("Already exists"), { notOpened: true });
        if (!this.machine.writable(path)) throw Object.assign(new Error("Permission denied"), { notOpened: true });
        const real = exclusive ? path : this.follow(path);
        if (!this.machine.files.has(real)) this.machine.files.set(real, { data: Buffer.alloc(0), mode: exclusive ? 0o100600 : 0o100644 });
        const file = this.machine.files.get(real);
        file.data = Buffer.alloc(0);
        const chunks = [];
        if (Buffer.isBuffer(source)) chunks.push(source);
        else for await (const chunk of source) chunks.push(chunk);
        file.data = Buffer.concat(chunks);
        const modeSet = !finalMode || this.machine.setsMode(path);
        if (finalMode && modeSet) file.mode = (file.mode & TYPE_MASK) | (finalMode & 0o777);
        this.record("write", path, { exclusive, finalMode }, file.data.length);
        if (!modeSet) throw new Error("Could not set permissions");
    }

    readFile(path, { backpressure = false } = {}) {
        world.reads.push([this.machine.name, path, backpressure]);
        const file = this.machine.files.get(this.follow(path));
        const stream = file?.stream ? file.stream() : Readable.from(file ? [file.data] : []);
        const done = finished(stream);
        done.catch(() => {});
        return { stream, totalSizePromise: Promise.resolve(file?.data.length ?? 0), done };
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
        engine: true, machines: new Map(Object.entries(machines)), opened: [], closed: [], logins: [], execs: [], ops: [], reads: [], stats: [],
        pinned: new Map(pinned.map(([itemId, ref, name]) =>
            [pinKeyOf(itemId, ref), { algorithm: "ssh-ed25519", fingerprint: fp(name), confirmedBy: 1, confirmedAt: new Date(0) }])),
    });
    dataSockets.clear();
};

module.exports = {
    world, fp, machine, reset,
    file: (text, mode) => ({ data: Buffer.from(text), mode }),
    pinned: (itemId, ref) => world.pinned.get(pinKeyOf(itemId, ref)) ?? null,
    forget: (itemId, ref) => world.pinned.delete(pinKeyOf(itemId, ref)),
};

const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { BrowserError, BrowserErrorCode } = require("./errors");

const MAX_CHANNELS = 6;
const HEAD_LIMIT = 16 * 1024;
const HEAD_TIMEOUT_MS = 10000;
const TLS_HANDSHAKE = 0x16;
// The browser container's own ports: its URLBlocklist refuses them before the resolver rule applies.
const RESERVED_PORTS = (port) => port === 9222 || port === 9300 || port === 10222 || (port >= 9230 && port <= 9269) || (port >= 10230 && port <= 10269);

const normalizeAddress = (address) => String(address ?? "").replace(/^::ffff:/, "");

const readHead = (client) => new Promise((resolve) => {
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => finish(null), HEAD_TIMEOUT_MS);
    const finish = (value) => {
        clearTimeout(timer);
        client.off("data", onData).off("end", onEnd).off("error", onEnd).off("close", onEnd);
        client.pause();
        resolve(value);
    };
    const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        if (head[0] === TLS_HANDSHAKE || head.includes("\r\n\r\n") || head.length >= HEAD_LIMIT) finish(head);
    };
    const onEnd = () => finish(null);
    client.on("data", onData).once("end", onEnd).once("error", onEnd).once("close", onEnd);
});

const hostOf = (head) => /\r\nhost:[ \t]*([^\r\n]*)/i.exec(head.toString("latin1"))?.[1].trim().toLowerCase() ?? null;

const createViaProxy = ({ openChannel, allowedRemote, expectHosts = null, maxChannels = MAX_CHANNELS, host = "0.0.0.0" }) => {
    let active = 0;
    const waiting = [];
    const sockets = new Set();

    const release = () => {
        active--;
        while (waiting.length > 0) {
            const next = waiting.shift();
            if (!next.destroyed) {
                connect(next);
                return;
            }
        }
    };

    const connect = async (client) => {
        active++;
        let channel;
        try {
            channel = await openChannel();
        } catch {
            client.destroy();
            release();
            return;
        }
        if (client.destroyed) {
            channel.destroy();
            release();
            return;
        }
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            client.destroy();
            channel.destroy();
            release();
        };
        client.on("close", finish).on("error", finish);
        channel.on("close", finish).on("error", finish);
        client.pipe(channel);
        channel.pipe(client);
    };

    // The listener sits on the server's interfaces; only the browser container may use it,
    // otherwise anyone on the network gets a tunnel to the via machine's localhost.
    const server = net.createServer(async (client) => {
        if (normalizeAddress(client.remoteAddress) !== normalizeAddress(allowedRemote)) {
            client.destroy();
            return;
        }
        sockets.add(client);
        client.on("close", () => sockets.delete(client));
        client.on("error", () => client.destroy());
        // Every page in the browser container shares allowedRemote. Only the via instance's own
        // requests carry the page's Host; a page that found this port or rebound a name onto it
        // carries its own. TLS passes: certificate checks already fail for a foreign name.
        if (expectHosts) {
            const head = await readHead(client);
            if (!head || (head[0] !== TLS_HANDSHAKE && !expectHosts.has(hostOf(head)))) {
                client.destroy();
                return;
            }
            client.unshift(head);
        }
        if (active < maxChannels) connect(client);
        else waiting.push(client);
    });

    return {
        listen: () => new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, host, () => resolve(server.address().port));
        }),
        close: () => {
            server.close();
            waiting.length = 0;
            for (const socket of sockets) socket.destroy();
        },
        get activeChannels() {
            return active;
        },
    };
};

const viaTargetFromUrl = (href) => {
    const url = new URL(href);
    const host = url.hostname;
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    if (net.isIP(host) || host.startsWith("["))
        throw new BrowserError(BrowserErrorCode.VIA_INVALID,
            `via needs a host name in the URL, not the IP address ${host}: Chromium applies its host resolver rules to names only. Use http://localhost:${port} instead.`);
    if (RESERVED_PORTS(port))
        throw new BrowserError(BrowserErrorCode.VIA_INVALID,
            `via cannot reach port ${port}: the browser container reserves 9222, 9230-9269, 9300, 10222 and 10230-10269 for itself`);
    return { host, port, remoteHost: host === "localhost" ? "127.0.0.1" : host };
};

const hostResolverRule = (target, proxyHost, proxyPort) => `MAP ${target.host}:${target.port} ${proxyHost}:${proxyPort}`;

const resolveViaTarget = async (accountId, via) => {
    const Entry = require("../../models/Entry");
    const { validateEntryAccess, resolveEntryScope } = require("../../controllers/entry");
    const { isConnectionReasonRequired } = require("../../controllers/audit");
    const { extractIdentity } = require("../ConnectionService");
    const { hasResourcePermission } = require("../../utils/permission");
    const { resolveIdentity } = require("../../utils/identityResolver");
    const { Permission } = require("../../permissions/registry");
    const controlPlane = require("../controlPlane/ControlPlaneServer");
    const fail = (message) => new BrowserError(BrowserErrorCode.VIA_INVALID, message);

    const key = String(via).trim();
    const candidates = /^\d+$/.test(key)
        ? [await Entry.findByPk(Number(key))].filter(Boolean)
        : await Entry.findAll({ where: { name: key } });
    const accessible = [];
    for (const entry of candidates) if ((await validateEntryAccess(accountId, entry)).valid) accessible.push(entry);
    if (accessible.length === 0) throw fail(`No server entry "${key}" that you have access to`);
    if (accessible.length > 1) throw fail(`"${key}" names several servers; pass the id instead: ${accessible.map((e) => `${e.id} (${e.name})`).join(", ")}`);

    const [entry] = accessible;
    const isSSH = entry.type === "ssh" || (entry.type === "server" && entry.config?.protocol === "ssh");
    if (!isSSH || !entry.config?.ip) throw fail(`${entry.name} is not an SSH server`);
    // entry.organizationId is null inside an organization folder; the folder decides.
    const { organizationId } = await resolveEntryScope(entry);
    if (!(await hasResourcePermission(accountId, organizationId, Permission.CONNECT_TUNNEL)))
        throw fail(`You are not allowed to create tunnels through ${entry.name}`);
    if (await isConnectionReasonRequired(organizationId))
        throw fail(`${entry.name} belongs to an organization that requires a connection reason, which via cannot give. Open the connection in Outpost instead.`);
    if (!controlPlane.hasEngine()) throw fail("No engine connected. via needs the Outpost Engine.");

    const result = await resolveIdentity(entry, null, null, accountId);
    const identity = extractIdentity(result);
    if (result?.accessDenied || !identity) throw fail(`No usable identity for ${entry.name}`);
    return { entry, identity, organizationId: organizationId ?? null };
};

const openEngineChannel = async ({ entry, identity, remoteHost, remotePort }) => {
    const controlPlane = require("../controlPlane/ControlPlaneServer");
    const { SessionType } = require("../generated/control_plane_generated");
    const { buildSSHParams, resolveJumpHosts, resolveCredentials, openEngineSession } = require("../ConnectionService");

    const sessionId = `browser-via-${randomUUID()}`;
    const params = { ...buildSSHParams(identity, await resolveCredentials(identity)), remoteHost, remotePort: String(remotePort) };
    let socket;
    try {
        socket = await openEngineSession(sessionId, SessionType.Tunnel, entry.config.ip, entry.config.port || 22, params,
            await resolveJumpHosts(entry), entry.config?.engineId);
    } catch (err) {
        // Also reached when the session opened but its data connection never came.
        controlPlane.closeSession(sessionId);
        throw err;
    }
    socket.once("close", () => controlPlane.closeSession(sessionId));
    return socket;
};

const createEngineVia = async ({ accountId, via, url, settings, launcher }) => {
    const target = viaTargetFromUrl(url);
    const { entry, identity, organizationId } = await resolveViaTarget(accountId, via);
    const expectHosts = new Set([`${target.host}:${target.port}`]);
    if (!new URL(url).port) expectHosts.add(target.host);
    const proxy = createViaProxy({
        allowedRemote: await launcher.resolveHost(),
        expectHosts,
        openChannel: () => openEngineChannel({ entry, identity, remoteHost: target.remoteHost, remotePort: target.port }),
    });
    const port = await proxy.listen();
    return {
        label: entry.name,
        organizationId,
        resolverRule: hostResolverRule(target, settings.callbackHost, port),
        close: () => proxy.close(),
    };
};

module.exports = { createViaProxy, viaTargetFromUrl, hostResolverRule, createEngineVia };

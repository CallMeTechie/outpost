const net = require("node:net");

const DEFAULT_PORT = 22;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const HOST_PORT = /^(\[[^\]]+\]|[^:[\]]+)(?::([0-9]{1,5}))?$/;
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/;

const normalizeHost = (text) => {
    const match = typeof text === "string" ? HOST_PORT.exec(text.trim().toLowerCase()) : null;
    if (!match) return null;
    const [, host, portText] = match;
    const port = portText === undefined ? DEFAULT_PORT : Number(portText);
    if (port < 1 || port > 65535) return null;
    if (host.startsWith("[") ? !net.isIPv6(host.slice(1, -1)) : !HOSTNAME.test(host)) return null;
    return port === DEFAULT_PORT ? host : `${host}:${port}`;
};

const targetRefsOf = (item) => [
    ...(item.fields?.servers ?? []).map((id) => `server:${id}`),
    ...(item.fields?.hosts ?? []).map((host) => `host:${host}`),
];

// Only the canonical spelling targetRefsOf produces; the host comes without IPv6 brackets, as the engine connects to it.
const parseTargetRef = (ref) => {
    if (typeof ref !== "string") return null;
    const server = /^server:([1-9][0-9]{0,9})$/.exec(ref);
    if (server) return { kind: "server", entryId: Number(server[1]) };
    const text = ref.startsWith("host:") ? ref.slice("host:".length) : null;
    if (text === null || normalizeHost(text) !== text) return null;
    const [, host, port] = HOST_PORT.exec(text);
    return { kind: "host", host: host.replace(/^\[(.*)\]$/, "$1"), port: port ? Number(port) : DEFAULT_PORT };
};

module.exports = { HIDDEN, normalizeHost, targetRefsOf, parseTargetRef };

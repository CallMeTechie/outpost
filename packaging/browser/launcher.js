const dns = require("node:dns");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CONTROL_PORT = Number(process.env.LAUNCHER_PORT || 9300);
const DEFAULT_PORT = 9222;
const FIRST_DYNAMIC_PORT = 9230;
const LAST_DYNAMIC_PORT = 9269;
const INTERNAL_OFFSET = 1000;
const STOP_GRACE_MS = 5000;
const PROFILE_ROOT = process.env.PROFILE_ROOT || "/profiles";
const DOWNLOAD_ROOT = process.env.DOWNLOAD_ROOT || "/downloads";
const POLICY_FILE = process.env.POLICY_FILE || "/etc/chromium/policies/managed/outpost.json";
const MAX_BODY = 16384;
const DOWNLOAD_MAX_AGE_MS = 24 * 3600 * 1000;
const DOWNLOAD_PRUNE_INTERVAL_MS = 3600 * 1000;
const ALLOWED_CLIENTS = (process.env.ALLOWED_CLIENTS || "").split(",").map((host) => host.trim()).filter(Boolean);
const ALLOWED_CACHE_MS = 10000;
const CHROMIUM = process.env.CHROMIUM_BIN || "/usr/bin/chromium";
const DISPLAY_SOCKET = "/tmp/.X11-unix/X99";
const KEY_PATTERN = /^[a-z0-9-]{1,64}$/;
const RULE_PATTERN = /^MAP [a-z0-9._-]+:\d{1,5} [a-z0-9._-]+:\d{1,5}$/i;
const PROFILE_PATH = /^\/profiles\/(account-\d{1,12})$/;
const KINDS = new Set(["default", "persistent", "ephemeral"]);
// No --remote-allow-origins: Chromium then refuses DevTools WebSockets that carry an Origin.
// That covers WebSockets only; the HTTP endpoints (/json/list, /json/close) are shut by URLBlocklist.
const BASE_ARGS = [
    "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--no-sandbox",
    "--remote-debugging-address=127.0.0.1", "--window-position=0,0", "--window-size=1920,1080",
];

const instances = new Map();
const exiting = new Map();
let shuttingDown = false;
let defaultFailures = 0;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const stripMapped = (address) => address.replace(/^::ffff:/i, "");

let allowedLookup = { at: 0, addresses: null };
const allowedAddresses = () => {
    const age = Date.now() - allowedLookup.at;
    if (allowedLookup.addresses && age < ALLOWED_CACHE_MS) return allowedLookup.addresses;
    const addresses = Promise.all(ALLOWED_CLIENTS.map((host) => dns.promises.lookup(host, { all: true }).catch(() => [])))
        .then((results) => new Set(results.flat().map((entry) => stripMapped(entry.address))));
    allowedLookup = { at: Date.now(), addresses };
    // A name that does not resolve yet (peer container still starting) must not stay denied for the whole cache window.
    addresses.then((set) => {
        if (!set.size && allowedLookup.addresses === addresses) allowedLookup = { at: 0, addresses: null };
    });
    return addresses;
};

const clientAllowed = async (remoteAddress) => {
    if (!ALLOWED_CLIENTS.length) return true;
    if (!remoteAddress) return false;
    return (await allowedAddresses()).has(stripMapped(remoteAddress));
};

const urlHost = (address) => new URL(`http://${address.includes(":") ? `[${address}]` : address}/`).host;

// Pages run in this container and reach everything it listens on. Chromium re-reads this at start.
// Internal DevTools ports are blocked for every host: a host list misses spellings such as
// [::ffff:127.0.0.1], which reach 127.0.0.1 all the same. The public ports stay host-bound so a
// via target elsewhere may use them; ALLOWED_CLIENTS guards those against this container's own pages.
const writePolicy = () => {
    const hosts = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", urlHost("::ffff:127.0.0.1"), urlHost("::ffff:0.0.0.0"), os.hostname().toLowerCase()]);
    for (const addresses of Object.values(os.networkInterfaces()))
        for (const { address, family } of addresses) {
            if (address.startsWith("fe80:")) continue;
            hosts.add(urlHost(address));
            if (family === "IPv4") hosts.add(urlHost(`::ffff:${address}`));
        }
    const publicPorts = [CONTROL_PORT, DEFAULT_PORT];
    for (let port = FIRST_DYNAMIC_PORT; port <= LAST_DYNAMIC_PORT; port++) publicPorts.push(port);
    const internalPorts = publicPorts.filter((port) => port !== CONTROL_PORT).map((port) => port + INTERNAL_OFFSET);
    const blocklist = new Set(internalPorts.map((port) => `*:${port}`));
    for (const host of hosts) for (const port of publicPorts) blocklist.add(`${host}:${port}`);
    if (blocklist.size > 900) throw new Error(`URLBlocklist would hold ${blocklist.size} entries, Chromium accepts 1000`);
    fs.mkdirSync(path.dirname(POLICY_FILE), { recursive: true });
    fs.writeFileSync(POLICY_FILE, JSON.stringify({ URLBlocklist: [...blocklist] }));
};

writePolicy();
if (!ALLOWED_CLIENTS.length) console.warn("ALLOWED_CLIENTS is not set: any host that reaches this container may use the launcher and the DevTools forwards");

// A container restart keeps /tmp: a stale lock makes Xvfb refuse display 99, a stale socket fakes readiness.
for (const stale of ["/tmp/.X99-lock", DISPLAY_SOCKET]) fs.rmSync(stale, { force: true });
const xvfb = spawn("Xvfb", [":99", "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], { stdio: "ignore" });
// Every Chromium needs this display; only a container restart brings both back together.
xvfb.once("exit", () => {
    if (!shuttingDown) process.exit(1);
});
const display = (async () => {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(DISPLAY_SOCKET)) {
        if (Date.now() > deadline) throw new Error("Xvfb did not start");
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
})();
display.catch(() => process.exit(1));

const freePort = () => {
    // An exiting instance holds its forward and its DevTools port until its process is gone.
    const used = new Set([...instances.values(), ...exiting.values()].map((instance) => instance.port));
    for (let port = FIRST_DYNAMIC_PORT; port <= LAST_DYNAMIC_PORT; port++) if (!used.has(port)) return port;
    throw new Error("no free DevTools port");
};

const waitForPort = (port, child, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
        if (child.exitCode !== null || child.signalCode !== null) {
            reject(new Error(`Chromium exited before opening DevTools on port ${port}`));
            return;
        }
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => {
            socket.destroy();
            resolve();
        });
        socket.once("error", () => {
            socket.destroy();
            if (Date.now() > deadline) reject(new Error(`Chromium did not open DevTools on port ${port}`));
            else setTimeout(attempt, 200);
        });
    };
    attempt();
});

// Chromium binds DevTools to loopback; this forward is the only way in from the container network.
const forward = (publicPort, internalPort) => new Promise((resolve, reject) => {
    const server = net.createServer(async (client) => {
        client.on("error", () => client.destroy());
        if (!(await clientAllowed(client.remoteAddress)) || client.destroyed) return client.destroy();
        const upstream = net.connect(internalPort, "127.0.0.1");
        const done = () => {
            client.destroy();
            upstream.destroy();
        };
        client.on("error", done).on("close", done);
        upstream.on("error", done).on("close", done);
        client.pipe(upstream).pipe(client);
    });
    server.once("error", reject);
    server.listen(publicPort, "0.0.0.0", () => {
        server.off("error", reject);
        server.on("error", (err) => console.error(`forward ${publicPort}: ${err.message}`));
        resolve(server);
    });
});

const onExit = (key, instance) => {
    if (instances.get(key) === instance) instances.delete(key);
    instance.server?.close();
    if (instance.tempDir)
        fs.promises.rm(instance.tempDir, { recursive: true, force: true }).catch((err) => console.error(`remove ${instance.tempDir}: ${err.message}`));
    if (key === "default" && !shuttingDown)
        setTimeout(() => start({ key: "default", kind: "default" }).catch((err) => console.error(err.message)),
            Math.min(1000 * 2 ** defaultFailures++, 30000));
};

const launch = async (key, kind, rules, instance) => {
    await display;
    await exiting.get(key)?.gone;
    if (instances.get(key) !== instance) throw new Error(`instance ${key} was stopped while starting`);
    instance.tempDir = kind === "ephemeral" ? fs.mkdtempSync(path.join(os.tmpdir(), `${key}-`)) : null;
    const userDataDir = instance.tempDir ?? path.join(PROFILE_ROOT, key);
    fs.mkdirSync(userDataDir, { recursive: true });
    // Stale locks of a killed instance make Chromium refuse the profile. Only this launcher starts
    // instances and never two on one key, so removing them cannot hand one profile to two processes.
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(userDataDir, lock), { force: true });
    const internalPort = instance.port + INTERNAL_OFFSET;
    const args = [
        `--remote-debugging-port=${internalPort}`, `--user-data-dir=${userDataDir}`,
        ...(rules ? [`--host-resolver-rules=${rules}`] : []), ...BASE_ARGS, "about:blank",
    ];
    instance.child = spawn(CHROMIUM, args, { stdio: "ignore" });
    instance.child.once("exit", () => onExit(key, instance));
    try {
        await waitForPort(internalPort, instance.child);
        if (instances.get(key) !== instance) throw new Error(`instance ${key} was stopped while starting`);
        const server = await forward(instance.port, internalPort);
        if (instances.get(key) !== instance || instance.child.exitCode !== null || instance.child.signalCode !== null) {
            server.close();
            throw new Error(`instance ${key} was stopped while starting`);
        }
        instance.server = server;
    } catch (err) {
        instance.child.kill("SIGKILL");
        throw err;
    }
    if (key === "default") defaultFailures = 0;
    return { key, port: instance.port };
};

const start = ({ key, kind, hostResolverRules = null }) => {
    if (!KEY_PATTERN.test(String(key ?? "")) || !KINDS.has(kind)) return Promise.reject(badRequest("invalid key or kind"));
    if (hostResolverRules && !RULE_PATTERN.test(hostResolverRules)) return Promise.reject(badRequest("invalid hostResolverRules"));
    const rules = hostResolverRules || null;
    const existing = instances.get(key);
    if (existing) {
        if (existing.kind !== kind || existing.rules !== rules)
            return Promise.reject(Object.assign(new Error(`instance ${key} runs with other settings`), { status: 409 }));
        return existing.ready;
    }
    const instance = { port: key === "default" ? DEFAULT_PORT : freePort(), kind, rules, child: null, tempDir: null, server: null };
    instance.ready = launch(key, kind, rules, instance);
    instances.set(key, instance);
    instance.ready.catch(() => {
        if (instances.get(key) === instance) instances.delete(key);
    });
    return instance.ready;
};

const stop = (key) => {
    const instance = instances.get(key);
    if (!instance) return false;
    instances.delete(key);
    const child = instance.child;
    const gone = !child || child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once("exit", resolve));
    const entry = { port: instance.port, gone };
    exiting.set(key, entry);
    // launch() of the same key waits on this; a process that never exits would block that key for good.
    const kill = setTimeout(() => child?.kill("SIGKILL"), STOP_GRACE_MS);
    gone.then(() => {
        clearTimeout(kill);
        if (exiting.get(key) === entry) exiting.delete(key);
    });
    child?.kill("SIGTERM");
    return true;
};

const removeProfile = async (key) => {
    stop(key);
    await exiting.get(key)?.gone;
    await fs.promises.rm(path.join(PROFILE_ROOT, key), { recursive: true, force: true });
};

const pruneDownloads = async () => {
    const cutoff = Date.now() - DOWNLOAD_MAX_AGE_MS;
    for (const entry of await fs.promises.readdir(DOWNLOAD_ROOT, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const file = path.join(DOWNLOAD_ROOT, entry.name);
        try {
            if ((await fs.promises.stat(file)).mtimeMs < cutoff) await fs.promises.rm(file, { force: true });
        } catch (err) {
            console.error(`prune ${file}: ${err.message}`);
        }
    }
};
const prune = () => pruneDownloads().catch((err) => console.error(`prune downloads: ${err.message}`));
prune();
setInterval(prune, DOWNLOAD_PRUNE_INTERVAL_MS).unref();

const readJson = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
            reject(Object.assign(new Error("body too large"), { status: 413 }));
            chunks.length = 0;
            setImmediate(() => req.destroy());
            return;
        }
        chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("close", () => reject(badRequest("request aborted")));
    req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
            resolve(raw ? JSON.parse(raw) : {});
        } catch {
            reject(badRequest("invalid JSON"));
        }
    });
});

// Every page in this container reaches the launcher on loopback. A form cannot set this header,
// and fetch() cannot set it without a CORS preflight the launcher never answers.
const fromOutpost = (req) => req.headers["x-outpost-launcher"] === "1";

http.createServer(async (req, res) => {
    const reply = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    };
    try {
        if (!(await clientAllowed(req.socket.remoteAddress)) || !fromOutpost(req)) return reply(403, { error: "forbidden" });
        const { pathname } = new URL(req.url, "http://launcher");
        if (req.method === "POST" && pathname === "/instances") return reply(200, await start(await readJson(req)));
        if (req.method === "GET" && pathname === "/instances") return reply(200, [...instances].map(([key, i]) => ({ key, port: i.port })));
        const match = /^\/instances\/([a-z0-9-]{1,64})$/.exec(pathname);
        if (req.method === "DELETE" && match) return stop(match[1]) ? reply(200, {}) : reply(404, { error: "unknown instance" });
        const profile = PROFILE_PATH.exec(pathname);
        if (req.method === "DELETE" && profile) {
            await removeProfile(profile[1]);
            return reply(200, {});
        }
        reply(404, { error: "not found" });
    } catch (err) {
        reply(err.status ?? 500, { error: err.message });
    }
}).listen(CONTROL_PORT, "0.0.0.0", () => {
    start({ key: "default", kind: "default" }).catch((err) => console.error(err.message));
});

process.on("SIGTERM", () => {
    shuttingDown = true;
    for (const instance of instances.values()) instance.child?.kill("SIGTERM");
    xvfb.kill("SIGTERM");
    setTimeout(() => process.exit(0), 2000).unref();
});

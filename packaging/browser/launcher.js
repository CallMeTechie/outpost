const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CONTROL_PORT = Number(process.env.LAUNCHER_PORT || 9300);
const DEFAULT_PORT = 9222;
const FIRST_DYNAMIC_PORT = 9230;
const LAST_DYNAMIC_PORT = 9429;
const INTERNAL_OFFSET = 1000;
const STOP_GRACE_MS = 5000;
const PROFILE_ROOT = process.env.PROFILE_ROOT || "/profiles";
const CHROMIUM = process.env.CHROMIUM_BIN || "/usr/bin/chromium";
const DISPLAY_SOCKET = "/tmp/.X11-unix/X99";
const KEY_PATTERN = /^[a-z0-9-]{1,64}$/;
const RULE_PATTERN = /^MAP [a-z0-9._-]+:\d{1,5} [a-z0-9._-]+:\d{1,5}$/i;
const PROFILE_PATH = /^\/profiles\/(account-\d{1,12})$/;
const KINDS = new Set(["default", "persistent", "ephemeral"]);
// No --remote-allow-origins: Chromium then refuses DevTools WebSockets that carry an Origin,
// which keeps pages in this container off every instance's DevTools.
const BASE_ARGS = [
    "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--no-sandbox",
    "--remote-debugging-address=127.0.0.1", "--window-position=0,0", "--window-size=1920,1080",
];

const instances = new Map();
const exiting = new Map();
let shuttingDown = false;
let defaultFailures = 0;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

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
    const server = net.createServer((client) => {
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
    if (instance.tempDir) fs.rmSync(instance.tempDir, { recursive: true, force: true });
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
        instance.server = await forward(instance.port, internalPort);
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
    fs.rmSync(path.join(PROFILE_ROOT, key), { recursive: true, force: true });
};

const readJson = (req) => new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 16384) req.destroy();
    });
    req.on("end", () => {
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
        if (!fromOutpost(req)) return reply(403, { error: "forbidden" });
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

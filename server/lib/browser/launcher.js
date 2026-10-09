const dns = require("node:dns/promises");

const REQUEST_TIMEOUT_MS = 20000;
const ENDPOINT_TIMEOUT_MS = 5000;

const createLauncherClient = (getBaseUrl, { fetchImpl = fetch, lookup = dns.lookup } = {}) => {
    const call = async (method, path, body) => {
        const base = new URL(await getBaseUrl());
        const res = await fetchImpl(new URL(path, base), {
            method,
            headers: { "content-type": "application/json", "x-outpost-launcher": "1" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`launcher ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
        return res.json();
    };

    const resolveHost = async () => (await lookup(new URL(await getBaseUrl()).hostname)).address;

    return {
        start: ({ key, kind, hostResolverRules = null }) => call("POST", "/instances", { key, kind, hostResolverRules }),
        stop: (key) => call("DELETE", `/instances/${encodeURIComponent(key)}`),
        list: () => call("GET", "/instances"),
        removeProfile: (key) => call("DELETE", `/profiles/${encodeURIComponent(key)}`),
        resolveHost,
        // Chromium answers DevTools HTTP only when the Host header is an IP or "localhost"
        // (DNS rebinding guard), so the container's name is resolved before asking.
        endpoint: async (port) => {
            const address = await resolveHost();
            const host = address.includes(":") ? `[${address}]` : address;
            const res = await fetchImpl(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS) });
            if (!res.ok) throw new Error(`DevTools endpoint on port ${port}: HTTP ${res.status}`);
            // Only the path is taken from the answer; host and port stay the ones asked.
            const { pathname } = new URL((await res.json()).webSocketDebuggerUrl);
            return `ws://${host}:${port}${pathname}`;
        },
    };
};

module.exports = { createLauncherClient };

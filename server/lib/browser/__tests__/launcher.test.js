const test = require("node:test");
const assert = require("node:assert");
const { createLauncherClient } = require("../launcher");

test("the DevTools endpoint is asked by IP, since Chromium refuses a host name in the Host header", async () => {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
        requests.push({ url: String(url), method: options.method ?? "GET", body: options.body });
        const body = String(url).endsWith("/json/version")
            ? { webSocketDebuggerUrl: "ws://10.0.0.7:9230/devtools/browser/abc" }
            : { key: "account-1", port: 9230 };
        return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };
    const lookup = async (host) => {
        assert.strictEqual(host, "outpost-browser");
        return { address: "10.0.0.7" };
    };
    const launcher = createLauncherClient(async () => "http://outpost-browser:9300", { fetchImpl, lookup });

    assert.deepStrictEqual(await launcher.start({ key: "account-1", kind: "persistent" }), { key: "account-1", port: 9230 });
    assert.strictEqual(requests[0].url, "http://outpost-browser:9300/instances");
    assert.deepStrictEqual(JSON.parse(requests[0].body), { key: "account-1", kind: "persistent", hostResolverRules: null });

    assert.strictEqual(await launcher.endpoint(9230), "ws://10.0.0.7:9230/devtools/browser/abc");
    assert.strictEqual(requests[1].url, "http://10.0.0.7:9230/json/version");
});

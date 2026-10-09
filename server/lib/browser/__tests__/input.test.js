const test = require("node:test");
const assert = require("node:assert");
const { toCdpCalls, assertNavigableUrl } = require("../input");
const { BrowserErrorCode } = require("../errors");

test("only http and https addresses can be opened", () => {
    assert.strictEqual(assertNavigableUrl("https://grafana.test/d/x?y=1"), "https://grafana.test/d/x?y=1");
    assert.strictEqual(assertNavigableUrl("http://localhost:5173"), "http://localhost:5173/");
    for (const url of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "data:text/html,<b>x</b>", "about:blank", "localhost:5173", "not a url", undefined]) {
        assert.throws(() => assertNavigableUrl(url), (err) => err.code === BrowserErrorCode.INVALID_URL, String(url));
    }
});

test("a size report is clamped and restarts the screencast at that size", () => {
    const calls = toCdpCalls({ type: "resize", width: 10000.4, height: 50 });
    assert.deepStrictEqual(calls, [
        { method: "Emulation.setDeviceMetricsOverride", params: { width: 3840, height: 200, deviceScaleFactor: 1, mobile: false } },
        { method: "Page.stopScreencast", params: {} },
        { method: "Page.startScreencast", params: { format: "jpeg", quality: 60, everyNthFrame: 1, maxWidth: 3840, maxHeight: 200 } },
    ]);
});

test("malformed input messages produce no CDP call", () => {
    for (const message of [
        { type: "mouse", action: "down", x: Number.NaN, y: 1 },
        { type: "mouse", action: "teleport", x: 1, y: 1 },
        { type: "mouse", action: "constructor", x: 1, y: 1 },
        { type: "key", action: "down" },
        { type: "key", action: "hold", key: "a" },
        { type: "navigate", url: "https://a.test" },
        { type: "nope" },
        null,
    ]) assert.deepStrictEqual(toCdpCalls(message), [], JSON.stringify(message));
});

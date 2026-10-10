const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const fake = (modulePath, exports) => {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
fake("../../utils/logger", { warn: () => {}, error: () => {}, info: () => {}, system: () => {} });

const { mountStaticSite } = require("../staticSite");
const cspReport = require("../../routes/cspReport");

const REPORT_ONLY = "content-security-policy-report-only";
const ENFORCED = "content-security-policy";

let server;
let baseUrl;
let distDir;

test.before(async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-csp-"));
    fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>Outpost</title>");

    const app = express();
    app.use(express.json());
    app.use("/api/csp-report", cspReport);
    mountStaticSite(app, distDir);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    delete process.env.CSP_ENFORCE;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(distDir, { recursive: true, force: true });
});

const getWithHost = (pathname, host) => new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { headers: { host } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res));
    });
    req.on("error", reject);
    req.end();
});

test("the client shell reports its policy but already refuses foreign framing (SEC-CSP-01)", async () => {
    for (const pathname of ["/", "/servers/42"]) {
        const res = await fetch(`${baseUrl}${pathname}`);
        const policy = res.headers.get(REPORT_ONLY);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get(ENFORCED), "frame-ancestors 'self'", `${pathname} enforces nothing but frame-ancestors yet`);
        assert.strictEqual(res.headers.get("x-frame-options"), "SAMEORIGIN");
        assert.match(policy, /default-src 'self'/);
        assert.match(policy, /object-src 'none'/);
        assert.match(policy, /report-uri \/api\/csp-report/);
        assert.ok(!policy.includes("frame-ancestors"), "framing is enforced on its own header, not reported twice");
        assert.ok(policy.includes(`wss://${new URL(baseUrl).host}`), "the state stream socket to the same host is allowed");
    }
});

test("CSP_ENFORCE=true sends the whole policy as an enforcing header", async (t) => {
    process.env.CSP_ENFORCE = "true";
    t.after(() => { delete process.env.CSP_ENFORCE; });

    const res = await fetch(`${baseUrl}/servers/42`);
    const policy = res.headers.get(ENFORCED);

    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /frame-ancestors 'self'/);
    assert.strictEqual(res.headers.get(REPORT_ONLY), null);
    assert.strictEqual(res.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("a forged Host header cannot append directives to the policy", async () => {
    const res = await getWithHost("/", "evil.example; script-src *");
    const policy = res.headers[REPORT_ONLY];

    assert.ok(!policy.includes("script-src *"), policy);
    assert.ok(!policy.includes("evil.example"), policy);
});

test("the report endpoint accepts both report formats without authentication", async () => {
    const legacy = await fetch(`${baseUrl}/api/csp-report`, {
        method: "POST",
        headers: { "Content-Type": "application/csp-report" },
        body: JSON.stringify({ "csp-report": { "document-uri": `${baseUrl}/vault`, "blocked-uri": "inline", "effective-directive": "script-src-elem" } }),
    });
    const reporting = await fetch(`${baseUrl}/api/csp-report`, {
        method: "POST",
        headers: { "Content-Type": "application/reports+json" },
        body: JSON.stringify([{ type: "csp-violation", body: { documentURL: `${baseUrl}/vault`, blockedURL: "eval", effectiveDirective: "script-src" } }]),
    });

    assert.strictEqual(legacy.status, 204);
    assert.strictEqual(reporting.status, 204);
});

test("report summaries keep only origin, path and known keywords, so tokens never reach the log (SEC-TOKEN-01)", () => {
    const summaries = [
        ...cspReport.summarizeReports({ "csp-report": {
            "document-uri": "https://outpost.example/servers?token=doc-secret",
            "blocked-uri": "wss://outpost.example/api/ws/state?sessionToken=state-secret",
            "violated-directive": "connect-src",
            "script-sample": "sample-secret",
        } }),
        ...cspReport.summarizeReports([
            { type: "csp-violation", body: {
                documentURL: "https://outpost.example/vault#frag-secret",
                blockedURL: "https://cdn.example/x.js?key=url-secret",
                sourceFile: "https://outpost.example/assets/index.js?v=src-secret",
                effectiveDirective: "script-src-elem",
                disposition: "report",
                sample: "sample-secret",
            } },
            { type: "csp-violation", body: { effectiveDirective: "token=directive-secret", disposition: "disposition-secret" } },
        ]),
    ];
    const logged = JSON.stringify(summaries);

    assert.ok(!/secret/.test(logged), logged);
    assert.strictEqual(summaries[0].blocked, "wss://outpost.example/api/ws/state");
    assert.strictEqual(summaries[0].directive, "connect-src");
    assert.strictEqual(summaries[1].blocked, "https://cdn.example/x.js");
    assert.strictEqual(summaries[1].disposition, "report");
    assert.strictEqual(summaries[2].directive, "[other]");
    assert.strictEqual(summaries[2].disposition, null);
});

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");
const { Sequelize } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const audits = [];
const opened = [];
const state = { enabled: true, permissions: ["connect.browser"], openError: null };
fake("../../utils/database", db);
fake("../../permissions/engine", { getSystemPermissions: async () => ({ isAdmin: false, permissions: state.permissions }) });
fake("../../controllers/browserSettings", { getBrowserSettings: async () => ({ enabled: state.enabled }) });
fake("../../controllers/audit", { createAuditLog: async (entry) => { audits.push(entry); } });
fake("../browser", {
    getBrowserPool: () => ({
        open: async (options) => {
            if (state.openError) throw state.openError;
            opened.push(options);
            const session = {
                id: "browser-1", accountId: options.accountId, organizationId: null, state: { url: "about:blank" },
                summary: () => ({ id: "browser-1", url: "about:blank", title: "", profile: options.profile, origin: options.origin }),
            };
            return { session, navigationError: null };
        },
    }),
});

const router = require("../../routes/browser");

const request = (method) => (server, path) => new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ port, path, method }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end();
});
const post = request("POST");
const get = request("GET");

const listen = async (t) => {
    const app = express();
    app.use((req, res, next) => { req.user = { id: 7 }; next(); });
    app.use("/api/browser", router);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    t.after(() => server.close());
    return server;
};

test("a user opens a persistent browser session on a blank page and the open is audited as theirs", async (t) => {
    const server = await listen(t);

    const { status, body } = await post(server, "/api/browser/sessions");

    assert.strictEqual(status, 201);
    assert.deepStrictEqual(opened, [{ accountId: 7, url: null, profile: "persistent", origin: "user" }]);
    assert.deepStrictEqual([body.id, body.origin, body.profile], ["browser-1", "user", "persistent"]);
    assert.strictEqual(audits.length, 1);
    assert.deepStrictEqual([audits[0].accountId, audits[0].action, audits[0].details.tool, audits[0].details.sessionId], [7, "browser.open", null, "browser-1"]);
});

test("the browser entry is offered only while the feature is on and the account holds connect.browser", async (t) => {
    const server = await listen(t);
    t.after(() => Object.assign(state, { enabled: true, permissions: ["connect.browser"] }));

    assert.deepStrictEqual((await get(server, "/api/browser/available")).body, { enabled: true });
    state.enabled = false;
    assert.deepStrictEqual((await get(server, "/api/browser/available")).body, { enabled: false });
    Object.assign(state, { enabled: true, permissions: [] });
    assert.deepStrictEqual((await get(server, "/api/browser/available")).body, { enabled: false });
});

test("an unreachable browser container answers 503 without its internal address", async (t) => {
    const { BrowserError, BrowserErrorCode } = require("../browser/errors");
    const server = await listen(t);
    state.openError = new BrowserError(BrowserErrorCode.UNAVAILABLE, "The browser container is not reachable (connect ECONNREFUSED 172.20.0.3:9300).");
    t.after(() => { state.openError = null; });

    const { status, body } = await post(server, "/api/browser/sessions");

    assert.strictEqual(status, 503);
    assert.doesNotMatch(JSON.stringify(body), /172\.20|9300/);
});

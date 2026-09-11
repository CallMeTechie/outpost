const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { mountStaticSite } = require("../staticSite");

let server;
let baseUrl;
let distDir;

test.before(async () => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-dist-"));
    fs.mkdirSync(path.join(distDir, "assets"));
    fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>Outpost</title>");
    fs.writeFileSync(path.join(distDir, "assets", "index-AAAA1111.js"), "export const x = 1;\n");

    const app = express();
    mountStaticSite(app, distDir);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(distDir, { recursive: true, force: true });
});

test("a chunk this build no longer ships answers 404, not the SPA shell", async () => {
    const res = await fetch(`${baseUrl}/assets/index-OLDHASH0.js`);

    assert.strictEqual(res.status, 404);
    assert.ok(!(res.headers.get("content-type") || "").includes("text/html"),
        "a stale tab must not receive index.html where it expects a JS module");
});

test("an asset this build does ship is served as JavaScript", async () => {
    const res = await fetch(`${baseUrl}/assets/index-AAAA1111.js`);

    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
    assert.strictEqual(await res.text(), "export const x = 1;\n");
});

test("a client-side route still falls back to index.html", async () => {
    const res = await fetch(`${baseUrl}/servers/42`);

    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /<title>Outpost<\/title>/);
});

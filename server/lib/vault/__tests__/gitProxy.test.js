process.env.VAULT_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { execFile, spawn } = require("node:child_process");
const express = require("express");
const selfsigned = require("selfsigned");
const { Sequelize } = require("sequelize");

// Foreign keys off: the fixtures create api_keys and vault rows without the full account graph behind them.
const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (modulePath, exports) => {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const ACCOUNT = 1;
const ENTRY_ID = 5;
const WINDOW_MS = 200;
const GIT_KEY = `outpost_${crypto.randomBytes(32).toString("hex")}`;
const TOKEN = `ghp_${crypto.randomBytes(18).toString("hex")}`;
const audits = [];
const cards = [];
const answer = { decision: "once" };

fake("../../../utils/database", db);
fake("../../../permissions/engine", {
    getSystemPermissions: async () => ({ isAdmin: false, permissions: ["vault.use"] }),
    getOrganizationPermissions: async () => ({ isOwner: false, isAdmin: false, permissions: [] }),
});
fake("../../../controllers/entry", {
    validateEntryAccess: async (accountId, entry) => (accountId === ACCOUNT ? { valid: true, entry } : { code: 403, message: "no" }),
    resolveEntryScope: async (entry) => ({ organizationId: null, ownerAccountId: entry.accountId }),
});
const audit = require("../../../controllers/audit");
audit.createAuditLog = async (entry) => { audits.push(entry); };

const { createGitProxy } = require("../gitProxy");
const { createGitRouter } = require("../../../routes/vault/git");
const { requestDeadline } = require("../../../middlewares/requestDeadline");
const stateBroadcaster = require("../../StateBroadcaster");
const approvals = require("../approvals");
const { initVaultState } = require("../state");
const { writeSecret } = require("../secrets");
const { hashToken } = require("../../../controllers/apiKey");
const Account = require("../../../models/Account");
const ApiKey = require("../../../models/ApiKey");
const Entry = require("../../../models/Entry");
const VaultItem = require("../../../models/VaultItem");

let tls;

test.before(async () => {
    await db.sync();
    await initVaultState();
    await Account.create({ id: ACCOUNT, firstName: "F", lastName: "L", username: "ada", password: "x" });
    await Entry.create({ id: ENTRY_ID, accountId: ACCOUNT, type: "server", name: "web01", config: { protocol: "ssh", ip: "192.0.2.10" } });
    await ApiKey.create({
        accountId: ACCOUNT, name: "git@web01", tokenHash: hashToken(GIT_KEY), prefix: `${GIT_KEY.slice(0, 14)}…`,
        kind: "agent", pending: false, entryId: ENTRY_ID, agentType: "git", ipBinding: false,
    });
    tls = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
        keySize: 2048, algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }],
    });
});

test.beforeEach(async () => {
    approvals._resetForTests();
    audits.length = 0;
    cards.length = 0;
    answer.decision = "once";
    await VaultItem.destroy({ where: {} });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Async on purpose: the Outpost under test runs in this process, a sync exec would block it.
const run = (cmd, args, { env = process.env, cwd } = {}) => new Promise((resolve) => {
    execFile(cmd, args, { env, cwd }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
});

// Plays the Git host: HTTPS with Basic-Auth in front of git http-backend (CGI) over a bare repo o/r.git.
const startUpstream = async (t, { onRequest = async () => {} } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-git-upstream-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = {
        PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test",
    };
    const bare = path.join(root, "o/r.git");
    const seed = path.join(root, "seed");
    await run("git", ["init", "-q", "--bare", "-b", "main", bare], { env });
    await run("git", ["init", "-q", "-b", "main", seed], { env });
    fs.writeFileSync(path.join(seed, "README"), "hello\n");
    await run("git", ["-C", seed, "add", "."], { env });
    await run("git", ["-C", seed, "commit", "-qm", "init"], { env });
    await run("git", ["-C", seed, "push", "-q", bare, "main"], { env });

    const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
    const seen = [];
    const server = https.createServer({ key: tls.private, cert: tls.cert }, async (req, res) => {
        const url = new URL(req.url, "https://localhost");
        const info = { method: req.method, path: url.pathname, query: url.search };
        seen.push(info);
        if (req.headers.authorization !== expected) {
            res.writeHead(401, { "www-authenticate": "Basic realm=\"git\"" });
            return res.end();
        }
        await onRequest(info);
        const cgi = spawn("git", ["http-backend"], {
            env: {
                PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "tester",
                REQUEST_METHOD: req.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
                CONTENT_TYPE: req.headers["content-type"] ?? "",
                ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
                HTTP_GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
                HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
            },
        });
        req.pipe(cgi.stdin);
        let buffered = Buffer.alloc(0);
        const onData = (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            const end = buffered.indexOf("\r\n\r\n");
            if (end < 0) return;
            cgi.stdout.off("data", onData);
            const headers = {};
            let status = 200;
            for (const line of buffered.subarray(0, end).toString().split("\r\n")) {
                const [name, ...value] = line.split(": ");
                if (name.toLowerCase() === "status") status = Number.parseInt(value.join(": "), 10);
                else headers[name] = value.join(": ");
            }
            res.writeHead(status, headers);
            res.write(buffered.subarray(end + 4));
            cgi.stdout.pipe(res);
        };
        cgi.stdout.on("data", onData);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    return { host: `localhost:${server.address().port}`, bare, seen };
};

// /slow stands for any other route that reads its whole body: there the deadline must still bite.
const listen = async (t, { deadlineMs = 300000, ...options } = {}) => {
    const app = express();
    app.use(requestDeadline({ ms: deadlineMs }));
    app.use(express.json());
    app.post("/slow", (req, res) => { req.resume(); req.on("end", () => res.end("read")); });
    app.use("/api/vault", createGitRouter(createGitProxy({ agent: new https.Agent({ ca: tls.cert }), ...options })));
    const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
};

// The same two lines the setup writes (Task 8), so Git on the "server" talks to Outpost instead of the host.
const makeHome = async (t, outpost, host) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "outpost-git-home-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = {
        HOME: home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C",
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test",
    };
    const git = (...args) => run("git", args, { env, cwd: home });
    await git("config", "--file", `${home}/.gitconfig`, `url.${outpost}/api/vault/git/${host}/.insteadOf`, `https://${host}/`);
    await git("config", "--file", `${home}/.gitconfig`, `http.${outpost}/api/vault/git/.extraHeader`, `Authorization: Bearer ${GIT_KEY}`);
    return { home, git };
};

const addItem = async (host, fields = {}, approvalRequired = false) => {
    const item = await VaultItem.create({
        accountId: ACCOUNT, name: "github", type: "api_key", approvalRequired, allServers: true, createdBy: ACCOUNT,
        fields: {
            hosts: [host], headerName: "Authorization", headerTemplate: "Bearer {{secret}}", readOnly: false, allowHttp: false,
            git: true, gitUsername: "x-access-token", fillOrigins: [], ...fields,
        },
    });
    await writeSecret(item.id, "token", TOKEN);
    return item;
};

// Plays the open Outpost window: every new card is answered with answer.decision.
const openWindow = (t) => {
    const ws = {
        readyState: 1,
        send: (raw) => {
            const message = JSON.parse(raw);
            if (message.type !== "VAULT_APPROVALS") return;
            for (const card of message.data) {
                if (cards.some((seen) => seen.id === card.id)) continue;
                cards.push(card);
                setImmediate(() => approvals.answerApproval(card.id, ACCOUNT, answer.decision));
            }
        },
    };
    stateBroadcaster.register(ACCOUNT, 1, ws, null, null, { impersonating: false });
    t.after(() => stateBroadcaster.unregister(ACCOUNT, ws));
};

const gitCall = async (url, { method = "GET", body, service = "upload-pack" } = {}) => {
    const res = await fetch(url, {
        method, body,
        headers: { authorization: `Bearer ${GIT_KEY}`, ...(body ? { "content-type": `application/x-git-${service}-request` } : {}) },
    });
    return { status: res.status, connection: res.headers.get("connection"), text: await res.text() };
};

// A POST whose body ("0000", a flush) arrives in two halves pauseMs apart, chunked as Git sends large bodies.
const trickle = (url, pauseMs) => new Promise((resolve) => {
    const req = http.request(url, {
        method: "POST", headers: { authorization: `Bearer ${GIT_KEY}`, "content-type": "application/x-git-upload-pack-request" },
    }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", () => {});
    req.write("00");
    setTimeout(() => req.end("00"), pauseMs);
});

const filesUnder = (dir) => fs.readdirSync(dir, { recursive: true })
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile());

test("git clone, Änderung, push und fetch laufen über Outpost; „Einmal“ deckt genau einen Vorgang, der Token erscheint nirgends auf dem Server", async (t) => {
    const upstream = await startUpstream(t);
    await addItem(upstream.host, {}, true);
    openWindow(t);
    const outpost = await listen(t, { windowMs: 1000 });
    const { home, git } = await makeHome(t, outpost, upstream.host);
    const work = path.join(home, "work");
    const outputs = [];
    const ok = async (...args) => {
        const result = await git(...args);
        outputs.push(result.stdout, result.stderr);
        assert.strictEqual(result.code, 0, result.stderr);
    };

    await ok("clone", `https://${upstream.host}/o/r.git`, work);
    for (const file of ["a.txt", "b.txt"]) {
        fs.writeFileSync(path.join(work, file), `${file}\n`);
        await ok("-C", work, "add", file);
        await ok("-C", work, "commit", "-qm", file);
        await ok("-C", work, "push", "origin", "main");
    }
    await ok("-C", work, "fetch", "origin");

    const target = `Git · ${upstream.host}/o/r`;
    assert.deepStrictEqual(cards.map((card) => [card.tool, card.access, card.target]),
        [["git", "read", target], ["git", "write", target], ["git", "write", target], ["git", "read", target]]);
    assert.strictEqual((await run("git", ["--git-dir", upstream.bare, "log", "--format=%s", "main"])).stdout, "b.txt\na.txt\ninit\n");

    await sleep(1500);
    const uses = audits.filter((entry) => entry.action === "vault.use");
    assert.deepStrictEqual(uses.map((entry) => entry.details.service).sort(), ["fetch", "fetch", "push", "push"]);
    assert.ok(uses.every((entry) => entry.details.tool === "git" && entry.details.host === upstream.host
        && entry.details.repo === "o/r" && entry.details.bytes > 0));

    const secrets = [TOKEN, Buffer.from(`x-access-token:${TOKEN}`).toString("base64")];
    const texts = [...filesUnder(home).map((file) => fs.readFileSync(file, "latin1")), ...outputs, JSON.stringify(audits)];
    assert.deepStrictEqual(texts.filter((text) => secrets.some((secret) => text.includes(secret))), []);
});

test("readOnly: clone gelingt, push endet mit remote error: vault: und vault.read_only, ohne den Git-Host zu erreichen", async (t) => {
    const upstream = await startUpstream(t);
    await addItem(upstream.host, { readOnly: true });
    const outpost = await listen(t);
    const { home, git } = await makeHome(t, outpost, upstream.host);
    const work = path.join(home, "work");

    assert.strictEqual((await git("clone", `https://${upstream.host}/o/r.git`, work)).code, 0);
    fs.writeFileSync(path.join(work, "a.txt"), "a\n");
    await git("-C", work, "add", "a.txt");
    await git("-C", work, "commit", "-qm", "a");
    const push = await git("-C", work, "push", "origin", "main");

    assert.notStrictEqual(push.code, 0);
    assert.match(push.stderr, /remote error: vault: .*\(vault\.read_only\)/);
    assert.ok(!upstream.seen.some((request) => `${request.path}${request.query}`.includes("receive-pack")));
    assert.deepStrictEqual(audits.filter((entry) => entry.action === "vault.use_denied").map((entry) => entry.details.code), ["vault.read_only"]);
});

test("ein POST ohne info/refs bekommt 403 vault.git_no_operation, andere Pfade 404, und nichts erreicht den Git-Host", async (t) => {
    const upstream = await startUpstream(t);
    await addItem(upstream.host);
    const outpost = await listen(t);
    const base = `${outpost}/api/vault/git/${upstream.host}`;

    const post = await gitCall(`${base}/o/r.git/git-upload-pack`, { method: "POST", body: "0000" });

    assert.deepStrictEqual([post.status, post.connection], [403, "close"]);
    assert.match(post.text, /\(vault\.git_no_operation\)/);
    for (const [method, url] of [
        ["GET", `${base}/o/r.git/objects/info/packs`],
        ["GET", `${base}/o/r.git/HEAD`],
        ["GET", `${base}/o/r.git/info/refs?service=git-foo`],
        ["GET", `${base}/o/r.git/info/refs`],
        ["POST", `${base}/o/r.git/info/lfs/objects/batch`],
        ["PUT", `${base}/o/r.git/git-receive-pack`],
        ["GET", `${base}/o/r.git/git-upload-pack`],
        ["GET", `${base}/o/r%20x.git/info/refs?service=git-upload-pack`],
        ["GET", `${base}/a/b/c/d/e/f/g/h/i.git/info/refs?service=git-upload-pack`],
        ["GET", `${outpost}/api/vault/git/localhost:443/o/r.git/info/refs?service=git-upload-pack`],
    ]) assert.strictEqual((await gitCall(url, { method })).status, 404, `${method} ${url}`);
    assert.deepStrictEqual(upstream.seen, []);
});

test("Review Focus 3 und 4: ein POST, der länger als das Vorgangsfenster läuft, hält den Vorgang offen; ein zweiter Push-POST während des ersten und geänderte Hosts zwischen info/refs und POST werden abgelehnt", async (t) => {
    let posts = 0;
    const upstream = await startUpstream(t, {
        onRequest: async ({ method, path: pathname }) => {
            if (method !== "POST") return;
            if (pathname.endsWith("/git-receive-pack")) return sleep(3 * WINDOW_MS);
            if (++posts === 1) await sleep(4 * WINDOW_MS);
        },
    });
    const item = await addItem(upstream.host);
    const outpost = await listen(t, { windowMs: WINDOW_MS });
    const { home, git } = await makeHome(t, outpost, upstream.host);
    const repo = `${outpost}/api/vault/git/${upstream.host}/o/r.git`;

    const clone = await git("clone", `https://${upstream.host}/o/r.git`, path.join(home, "work"));

    assert.strictEqual(clone.code, 0, clone.stderr);
    assert.ok(posts >= 2, "protocol v2 sends ls-refs and fetch as separate POSTs");
    await sleep(2 * WINDOW_MS);
    assert.strictEqual((await gitCall(`${repo}/git-upload-pack`, { method: "POST", body: "0000" })).status, 403);

    assert.strictEqual((await gitCall(`${repo}/info/refs?service=git-receive-pack`)).status, 200);
    const firstPush = gitCall(`${repo}/git-receive-pack`, { method: "POST", body: "0000", service: "receive-pack" });
    await sleep(WINDOW_MS / 2);
    const secondPush = await gitCall(`${repo}/git-receive-pack`, { method: "POST", body: "0000", service: "receive-pack" });
    assert.strictEqual(secondPush.status, 403);
    assert.match(secondPush.text, /\(vault\.git_no_operation\)/);
    assert.strictEqual((await firstPush).status, 200);

    const advertisement = await gitCall(`${repo}/info/refs?service=git-upload-pack`);
    assert.strictEqual(advertisement.status, 200);
    assert.match(advertisement.text, /# service=git-upload-pack/);
    await VaultItem.update({ fields: { ...item.fields, hosts: [upstream.host, "git.example.net"] } }, { where: { id: item.id } });
    const seen = upstream.seen.length;
    const stale = await gitCall(`${repo}/git-upload-pack`, { method: "POST", body: "0000" });

    assert.strictEqual(stale.status, 403);
    assert.match(stale.text, /\(vault\.approval_stale\)/);
    assert.strictEqual(upstream.seen.length, seen);

    assert.strictEqual((await gitCall(`${repo}/info/refs?service=git-receive-pack`)).status, 200);
    await VaultItem.update({ fields: { ...item.fields, hosts: [upstream.host, "git.example.org"] } }, { where: { id: item.id } });
    const audited = audits.length;
    const retries = [];
    for (let i = 0; i < 4; i++) retries.push(await gitCall(`${repo}/git-receive-pack`, { method: "POST", body: "0000", service: "receive-pack" }));

    assert.ok(retries.every((retry) => retry.status === 403));
    const denied = audits.slice(audited).filter((entry) => entry.action === "vault.use_denied").map((entry) => entry.details.code);
    assert.strictEqual(denied.length, new Set(denied).size, denied.join(", "));
});

test("Spec-Test 6a: die Upload-Frist beendet einen langsamen Body an einer anderen Route, ein geprüfter Git-POST läuft über sie hinaus", async (t) => {
    const deadlineMs = 300;
    const upstream = await startUpstream(t);
    await addItem(upstream.host.toUpperCase());
    const outpost = await listen(t, { deadlineMs });
    const repo = `${outpost}/api/vault/git/${upstream.host}/o/r.git`;

    assert.strictEqual((await trickle(`${outpost}/slow`, 2 * deadlineMs)).status, 408);
    assert.strictEqual((await gitCall(`${repo}/info/refs?service=git-upload-pack`)).status, 200);
    const seen = upstream.seen.length;
    const post = await trickle(`${repo}/git-upload-pack`, 2 * deadlineMs);

    assert.strictEqual(post.status, 200);
    assert.deepStrictEqual(upstream.seen.slice(seen).map((request) => `${request.method} ${request.path}`), ["POST /o/r.git/git-upload-pack"]);
});

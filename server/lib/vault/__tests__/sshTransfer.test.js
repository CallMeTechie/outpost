const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { Readable, PassThrough } = require("node:stream");

const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
const agentIdentity = { user: "ma" };
// Installed before ConnectionService loads: it destructures resolveIdentity and getIdentityCredentials.
fake("../../../utils/identityResolver", {
    resolveIdentity: async (entry, identityId) => (identityId === 7 ? { id: 7, username: agentIdentity.user } : { identity: null }),
});
fake("../../../controllers/identity", { getIdentityCredentials: async () => ({ password: "agent-identity-password" }), listIdentities: async () => [] });

const ssh = require("./helpers/sshBed");
const bed = require("./helpers/vaultBed");
require("../../../models/ApiKey").findByPk = async (id) => (id === 5 ? { id: 5, entryId: 30, identityId: 7, remoteUser: "ma" } : null);
require("../../../controllers/audit").createAuditLog = async () => {};
const stateBroadcaster = require("../../StateBroadcaster");
const controlPlane = require("../../controlPlane/ControlPlaneServer");
const approvals = require("../approvals");
const { Permission } = require("../../../permissions/registry");
const { createVaultProvider } = require("../mcpProvider");

const ITEM = {
    id: 61, accountId: 1, organizationId: null, name: "deploy", type: "ssh", description: null, updatedAt: "2026-10-12T08:00:00.000Z",
    fields: { username: "deploy", servers: [12], hosts: [], allowSession: false }, approvalRequired: false, allServers: true,
};
const WEB02 = { id: 12, type: "server", name: "web02", accountId: 1, organizationId: null, config: { protocol: "ssh", ip: "10.0.0.12", port: 22 } };
const APPMONSTER = { id: 30, type: "server", name: "appmonster", accountId: 1, organizationId: null, config: { protocol: "ssh", ip: "10.0.0.30", port: 22 } };
const { file } = ssh;

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(condition(), "condition not reached");
};

let windows = 0;
const setup = (t, { approvalRequired = false } = {}) => {
    bed.reset({
        items: [{ ...ITEM, approvalRequired, fields: { ...ITEM.fields } }], secrets: { "61:password": "deploy-password-1" },
        permissions: [Permission.VAULT_USE, Permission.CONNECT_SSH], entries: [WEB02, APPMONSTER], apiKeys: [5],
    });
    ssh.reset({
        machines: { "10.0.0.12:22": ssh.machine("web02"), "10.0.0.30:22": ssh.machine("appmonster", { home: "/home/ma" }) },
        pinned: [[61, "server:12", "web02"]],
    });
    approvals._resetForTests();
    const ws = { readyState: 1, send: () => {} };
    stateBroadcaster.register(1, `transfer-window-${windows++}`, ws);
    t.after(() => stateBroadcaster.unregister(1, ws));
    const audits = [];
    const provider = createVaultProvider({ getBrowserTools: () => null, approvals, audit: async (entry) => { audits.push(entry); } });
    const ctx = {
        accountId: 1, keyId: 5, agent: { keyId: 5, entryId: 30, agentType: "claude" }, impersonatorId: null, transportId: "T1",
        ipAddress: "10.0.0.30", userAgent: "claude-code", signal: new AbortController().signal,
    };
    const cards = () => approvals.listOpenApprovals(1);
    return {
        provider, ctx, cards, audits,
        web02: ssh.world.machines.get("10.0.0.12:22"),
        appmonster: ssh.world.machines.get("10.0.0.30:22"),
        call: (tool, args, over = {}) => provider.call(tool, { item: "deploy", target: "server:12", ...args }, { ...ctx, ...over }),
        text: (result) => result.content.map((c) => c.text).join(""),
        answer: (decision) => approvals.answerApproval(cards()[0].id, 1, decision),
        ops: (name) => ssh.world.ops.filter(([, machine]) => machine === name).map(([op, , ...args]) => [op, ...args]),
    };
};

test.afterEach(() => approvals._resetForTests());

test("ssh_put writes one exclusively created temp file with a random name and the source's mode, then renames it; it never writes through a planted link, asks stat for no owner and audits paths and size without the content", async (t) => {
    const env = setup(t);
    const planted = "/srv/app/app.tar.gz.outpost-00000000.tmp";
    env.web02.files.set("/srv/app/.profile", file("victim", 0o100644));
    env.web02.files.set(planted, { link: "/srv/app/.profile" });
    env.appmonster.files.set("/home/ma/build/app.tar.gz", file("archive-bytes", 0o100750));

    const result = await env.call("ssh_put", { localPath: "~/build/app.tar.gz", remotePath: "/srv/app/app.tar.gz" });
    assert.strictEqual(env.text(result), "Copied 13 bytes from ~/build/app.tar.gz to /srv/app/app.tar.gz.");
    const ops = env.ops("web02");
    const temp = ops[0][1];
    assert.match(temp, /^\/srv\/app\/app\.tar\.gz\.outpost-[0-9a-f]{8}\.tmp$/);
    assert.notStrictEqual(temp, planted);
    assert.deepStrictEqual(ops, [["write", temp, { exclusive: true, finalMode: 0o750 }, 13], ["rename", temp, "/srv/app/app.tar.gz"]]);
    const copied = env.web02.files.get("/srv/app/app.tar.gz");
    assert.deepStrictEqual([copied.data.toString(), copied.mode], ["archive-bytes", 0o100750]);
    assert.deepStrictEqual([env.web02.files.get("/srv/app/.profile").data.toString(), env.web02.files.get(planted)], ["victim", { link: "/srv/app/.profile" }]);
    assert.deepStrictEqual(ssh.world.reads, [["appmonster", "/home/ma/build/app.tar.gz", true]]);
    assert.ok(ssh.world.stats.length > 0 && ssh.world.stats.every(([, , owner]) => owner === false), "stat never looks up the owner");
    const use = env.audits.find((entry) => entry.action === "vault.use");
    assert.deepStrictEqual([use.details.from, use.details.to, use.details.bytes], ["~/build/app.tar.gz", "/srv/app/app.tar.gz", 13]);
    assert.ok(!JSON.stringify(env.audits).includes("archive-bytes"));

    env.appmonster.files.set("/home/ma/build/app2.tar.gz", file("next", 0o100644));
    assert.ok(!(await env.call("ssh_put", { localPath: "/home/ma/build/app2.tar.gz", remotePath: "/srv/app/app2.tar.gz" })).isError);
    assert.notStrictEqual(env.ops("web02")[2][1].slice(-17), temp.slice(-17), "every call draws a new temp name");

    t.mock.method(crypto, "randomBytes", () => Buffer.alloc(4));
    const collided = await env.call("ssh_put", { localPath: "~/build/app.tar.gz", remotePath: "/srv/app/app.tar.gz", overwrite: true });
    assert.strictEqual(env.text(collided), "/srv/app/app.tar.gz: already exists; nothing was copied. (vault.ssh_failed)");
    assert.deepStrictEqual([env.web02.files.get("/srv/app/.profile").data.toString(), env.web02.files.get("/srv/app/app.tar.gz").data.toString()],
        ["victim", "archive-bytes"]);
    assert.deepStrictEqual(env.web02.files.get(planted), { link: "/srv/app/.profile" }, "an entry this call did not create is never unlinked");
});

test("an existing file is only replaced with overwrite: true, the old one goes right before the rename and its mode stays; a directory is never replaced; ssh_get refuses an existing local file before the card", async (t) => {
    const env = setup(t);
    env.web02.files.set("/srv/app/app.tar.gz", file("old", 0o100640));
    env.web02.files.set("/srv/app/releases", file("", 0o040755));
    env.appmonster.files.set("/home/ma/build/app.tar.gz", file("archive-bytes", 0o100755));
    const args = { localPath: "~/build/app.tar.gz", remotePath: "/srv/app/app.tar.gz" };

    assert.strictEqual(env.text(await env.call("ssh_put", args)), "/srv/app/app.tar.gz exists; pass overwrite: true to replace it. (vault.file_exists)");
    assert.deepStrictEqual(env.ops("web02"), []);

    assert.ok(!(await env.call("ssh_put", { ...args, overwrite: true })).isError);
    const temp = env.ops("web02")[0][1];
    assert.deepStrictEqual(env.ops("web02"), [
        ["write", temp, { exclusive: true, finalMode: 0o640 }, 13], ["unlink", "/srv/app/app.tar.gz"], ["rename", temp, "/srv/app/app.tar.gz"],
    ]);
    const replaced = env.web02.files.get("/srv/app/app.tar.gz");
    assert.deepStrictEqual([replaced.data.toString(), replaced.mode], ["archive-bytes", 0o100640]);

    assert.strictEqual(env.text(await env.call("ssh_put", { ...args, remotePath: "/srv/app/releases", overwrite: true })),
        "/srv/app/releases is not a regular file. (vault.not_a_file)");
    assert.strictEqual(env.ops("web02").length, 3);

    bed.state.items[0].approvalRequired = true;
    env.appmonster.files.set("/home/ma/logs/app.log", file("local", 0o100644));
    const before = ssh.world.logins.length;
    const get = await env.call("ssh_get", { remotePath: "/var/log/app.log", localPath: "~/logs/app.log" });
    assert.strictEqual(env.text(get), "~/logs/app.log exists; pass overwrite: true to replace it. (vault.file_exists)");
    assert.deepStrictEqual([env.cards(), ssh.world.logins.slice(before).map((login) => login.machine)], [[], ["appmonster"]]);
});

test("ssh_get logs in at the target only after the approval: the card names the file without a size and the source is checked in act", async (t) => {
    const env = setup(t, { approvalRequired: true });
    env.web02.files.set("/var/log/app.log", file("log-line\n", 0o100600));
    env.web02.files.set("/var/log", file("", 0o040755));

    const pending = env.call("ssh_get", { remotePath: "/var/log/app.log", localPath: "~/logs/app.log" });
    await until(() => env.cards().length === 1);
    assert.deepStrictEqual([env.cards()[0].access, env.cards()[0].file], ["read", { from: "/var/log/app.log", to: "~/logs/app.log", bytes: null }]);
    assert.deepStrictEqual(ssh.world.logins.map((login) => login.machine), ["appmonster"], "only the own server, for the local check");
    env.answer("once");
    assert.strictEqual(env.text(await pending), "Copied 9 bytes from /var/log/app.log to ~/logs/app.log.");
    const copied = env.appmonster.files.get("/home/ma/logs/app.log");
    assert.deepStrictEqual([copied.data.toString(), copied.mode], ["log-line\n", 0o100600]);

    const directory = env.call("ssh_get", { remotePath: "/var/log", localPath: "~/logs/dir" });
    await until(() => env.cards().length === 1);
    env.answer("once");
    assert.strictEqual(env.text(await directory), "/var/log is not a regular file. (vault.not_a_file)");
    assert.strictEqual(env.appmonster.files.has("/home/ma/logs/dir"), false);
});

test("a transfer that passes 100 MB, whose call ends, even during the login or before its temp file is open, or whose source cannot be read stops, deletes only a temp file it created and closes its sessions", async (t) => {
    const env = setup(t);
    const MIB = Buffer.alloc(1024 * 1024);
    env.web02.files.set("/var/log/huge.log", {
        ...file("small", 0o100644),
        stream: () => Readable.from((function* () { for (let i = 0; i <= 100; i += 1) yield MIB; })()),
    });
    const huge = await env.call("ssh_get", { remotePath: "/var/log/huge.log", localPath: "/home/ma/huge.log" });
    assert.strictEqual(env.text(huge), "/var/log/huge.log is larger than 100 MB. (vault.file_too_large)");
    assert.deepStrictEqual([[...env.appmonster.files.keys()], env.ops("appmonster").map(([op]) => op)], [[], ["unlink"]]);

    const controller = new AbortController();
    env.web02.files.set("/var/log/live.log", {
        ...file("x", 0o100644),
        stream: () => {
            const stream = new PassThrough();
            stream.write(Buffer.from("partial"));
            return stream;
        },
    });
    const live = env.call("ssh_get", { remotePath: "/var/log/live.log", localPath: "/home/ma/live.log" }, { signal: controller.signal });
    await until(() => env.appmonster.files.size === 1);
    controller.abort();
    assert.ok(env.text(await live).endsWith("(vault.client_gone)"));
    assert.deepStrictEqual([...env.appmonster.files.keys()], []);

    let answerWriteBegin = null;
    const writeBegin = env.appmonster.writeBegin;
    env.appmonster.writeBegin = () => new Promise((resolve) => { answerWriteBegin = resolve; });
    const early = new AbortController();
    const beforeOpen = env.call("ssh_get", { remotePath: "/var/log/live.log", localPath: "/home/ma/early.log" }, { signal: early.signal });
    await until(() => answerWriteBegin !== null);
    early.abort();
    await new Promise((resolve) => setImmediate(resolve));
    answerWriteBegin();
    env.appmonster.writeBegin = writeBegin;
    assert.ok(env.text(await beforeOpen).endsWith("(vault.client_gone)"));
    assert.deepStrictEqual([...env.appmonster.files.keys()], []);

    const { openSession, closeSession } = controlPlane;
    t.after(() => Object.assign(controlPlane, { openSession, closeSession }));
    let opens = 0;
    let hung = null;
    controlPlane.openSession = (sessionId, ...rest) => (++opens === 2
        ? new Promise((_, reject) => { hung = { sessionId, reject }; })
        : openSession(sessionId, ...rest));
    controlPlane.closeSession = (sessionId, ...rest) => {
        if (sessionId === hung?.sessionId) hung.reject(new Error("Session closed"));
        return closeSession(sessionId, ...rest);
    };
    const opening = new AbortController();
    const duringOpen = env.call("ssh_get", { remotePath: "/var/log/live.log", localPath: "/home/ma/opening.log" }, { signal: opening.signal });
    await until(() => hung !== null);
    opening.abort();
    assert.ok(env.text(await duringOpen).endsWith("(vault.client_gone)"), "the call ends while the login still hangs");
    Object.assign(controlPlane, { openSession, closeSession });

    env.web02.files.set("/var/log/secret.log", {
        ...file("secret", 0o100600),
        stream: () => {
            const stream = new PassThrough();
            process.nextTick(() => stream.destroy(new Error("Permission denied")));
            return stream;
        },
    });
    const unreadable = { remotePath: "/var/log/secret.log", localPath: "/home/ma/secret.log" };
    assert.strictEqual(env.text(await env.call("ssh_get", unreadable)), "/var/log/secret.log: permission denied; nothing was copied. (vault.ssh_failed)");
    assert.deepStrictEqual([...env.appmonster.files.keys()], []);

    t.mock.method(crypto, "randomBytes", () => Buffer.alloc(4));
    env.appmonster.files.set("/home/ma/secret.log.outpost-00000000.tmp", file("not ours", 0o100644));
    assert.strictEqual(env.text(await env.call("ssh_get", unreadable)), "/home/ma/secret.log: already exists; nothing was copied. (vault.ssh_failed)");
    assert.deepStrictEqual([...env.appmonster.files.keys()], ["/home/ma/secret.log.outpost-00000000.tmp"]);
    const sessions = ssh.world.opened.filter(({ options }) => !options.probeHostKey).map(({ sessionId }) => sessionId);
    assert.deepStrictEqual(sessions.filter((id) => !ssh.world.closed.includes(id)), [], "every session is closed again");
});

test("file transfer needs an agent key on a server whose identity is its remote user; vault_list names ssh_put and ssh_get only then", async (t) => {
    const env = setup(t);
    env.appmonster.files.set("/home/ma/a.txt", file("a", 0o100644));
    const args = { localPath: "/home/ma/a.txt", remotePath: "/tmp/a.txt" };
    const usable = async (over) => JSON.parse(env.text(await env.provider.call("vault_list", {}, { ...env.ctx, ...over })))[0].usableBy;

    assert.deepStrictEqual(await usable({}), ["ssh_exec", "ssh_put", "ssh_get"]);
    assert.deepStrictEqual(await usable({ agent: null, keyId: null }), ["ssh_exec"]);
    assert.strictEqual(env.text(await env.call("ssh_put", args, { agent: null, keyId: null })),
        "File transfer needs an agent key set up on a server; this connection has none. (vault.no_agent_server)");

    agentIdentity.user = "root";
    t.after(() => { agentIdentity.user = "ma"; });
    assert.ok(env.text(await env.call("ssh_put", args)).endsWith("(vault.no_agent_server)"));
    assert.deepStrictEqual([ssh.world.opened, env.ops("web02")], [[], []]);
});

test("a relative path is refused before any connection; a target directory without write permission or an unreadable home directory reports the SFTP status, not a connection failure; a file whose mode cannot be set, also mode 000, is still placed with 0600 and a note", async (t) => {
    const env = setup(t);
    env.appmonster.files.set("/home/ma/a.txt", file("a", 0o100644));
    env.web02.writable = (path) => !path.startsWith("/srv/locked/");
    env.web02.setsMode = (path) => !path.startsWith("/srv/nomode/");

    assert.strictEqual(env.text(await env.call("ssh_put", { localPath: "a.txt", remotePath: "/srv/a.txt" })),
        "Paths must be absolute or start with ~/, at most 4 KB, on one line, without control characters. (vault.bad_path)");
    assert.deepStrictEqual(ssh.world.opened, []);

    assert.strictEqual(env.text(await env.call("ssh_put", { localPath: "/home/ma/a.txt", remotePath: "/srv/locked/a.txt" })),
        "/srv/locked/a.txt: permission denied; nothing was copied. (vault.ssh_failed)");
    assert.deepStrictEqual([...env.web02.files.keys()].filter((path) => path.startsWith("/srv/locked/")), []);

    assert.strictEqual(env.text(await env.call("ssh_put", { localPath: "/home/ma/a.txt", remotePath: "/srv/nomode/a.txt" })),
        "Copied 1 bytes from /home/ma/a.txt to /srv/nomode/a.txt. Permissions could not be set; the file keeps mode 0600.");
    const placed = env.web02.files.get("/srv/nomode/a.txt");
    assert.deepStrictEqual([placed.data.toString(), placed.mode], ["a", 0o100600]);
    assert.strictEqual(env.audits.filter((entry) => entry.action === "vault.use").pop().details.modeSet, false);

    env.appmonster.files.set("/home/ma/none.txt", file("n", 0o100000));
    assert.strictEqual(env.text(await env.call("ssh_put", { localPath: "/home/ma/none.txt", remotePath: "/srv/none.txt" })),
        "Copied 1 bytes from /home/ma/none.txt to /srv/none.txt. Permissions could not be set; the file keeps mode 0600.");
    assert.strictEqual(env.web02.files.get("/srv/none.txt").mode, 0o100600);

    assert.strictEqual(env.text(await env.call("ssh_put", { localPath: "/home/ma/$&.txt", remotePath: "/srv/a.txt" })),
        "/home/ma/$&.txt is not a regular file. (vault.not_a_file)");

    env.appmonster.home = null;
    assert.strictEqual(env.text(await env.call("ssh_put", { localPath: "~/a.txt", remotePath: "/srv/a.txt" })),
        "~/a.txt: permission denied; nothing was copied. (vault.ssh_failed)");
});

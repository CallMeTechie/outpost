const test = require("node:test");
const assert = require("node:assert");
const ssh = require("./helpers/sshBed");
const bed = require("./helpers/vaultBed");
// approvals.js destructures createAuditLog when it loads; the in-memory database has no tables.
require("../../../controllers/audit").createAuditLog = async () => {};
const stateBroadcaster = require("../../StateBroadcaster");
const approvals = require("../approvals");
const { Permission } = require("../../../permissions/registry");
const { SessionType } = require("../../generated/control_plane_generated");
const { createVaultProvider } = require("../mcpProvider");

const PASSWORD = "s3cr3t-Pa55word!";
const PASSPHRASE = "key passphrase/42";
const KEY_LINES = ["one", "two", "three"].map((n) => Buffer.from(`outpost-test-key-line-${n}-padding`).toString("base64"));
const KEY = ["-----BEGIN OPENSSH PRIVATE KEY-----", ...KEY_LINES, "-----END OPENSSH PRIVATE KEY-----"].join("\n");
const ITEM = {
    id: 61, accountId: 1, organizationId: null, name: "deploy", type: "ssh", description: null, updatedAt: "2026-10-12T08:00:00.000Z",
    fields: { username: "deploy", servers: [12], hosts: ["nas.lan:2222"], allowSession: false }, approvalRequired: false, allServers: true,
};
const WEB02 = { id: 12, type: "server", name: "web02", accountId: 1, organizationId: null, folderId: null, config: { protocol: "ssh", ip: "10.0.0.12", port: 22 } };
const ALL = [Permission.VAULT_USE, Permission.CONNECT_SSH, Permission.CONNECT_DIRECT];
const WEB02_KEY = [61, "server:12", "web02"];
const NAS_KEY = [61, "host:nas.lan:2222", "nas"];

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(condition(), "condition not reached");
};

let windows = 0;
const openWindow = (t, { impersonating = false } = {}) => {
    const messages = [];
    const ws = { readyState: 1, send: (raw) => messages.push(JSON.parse(raw)) };
    stateBroadcaster.register(1, `ssh-window-${windows++}`, ws, null, null, { impersonating });
    t.after(() => stateBroadcaster.unregister(1, ws));
    return { notices: () => messages.filter((m) => m.type === "VAULT_NOTICE").map((m) => m.data) };
};

const setup = (t, { item = {}, fields = {}, permissions = ALL, pinned = [], extraItems = [] } = {}) => {
    bed.reset({
        items: [{ ...ITEM, ...item, fields: { ...ITEM.fields, ...fields } }, ...extraItems],
        secrets: { "61:privateKey": KEY, "61:passphrase": PASSPHRASE, "61:password": PASSWORD },
        permissions, entries: [WEB02], apiKeys: [5],
    });
    ssh.reset({ machines: { "10.0.0.12:22": ssh.machine("web02"), "nas.lan:2222": ssh.machine("nas") }, pinned });
    approvals._resetForTests();
    const audit = [];
    const provider = createVaultProvider({ getBrowserTools: () => null, approvals, audit: async (entry) => { audit.push(entry); } });
    const window = openWindow(t);
    const ctx = {
        accountId: 1, keyId: 5, agent: { keyId: 5, entryId: 30, agentType: "claude" }, impersonatorId: null, transportId: "T1",
        ipAddress: "10.0.0.30", userAgent: "claude-code", signal: new AbortController().signal,
    };
    const exec = (args, signal = ctx.signal) => provider.call("ssh_exec", { item: "deploy", target: "server:12", ...args }, { ...ctx, signal });
    const text = (result) => result.content.map((c) => c.text).join("");
    const cards = () => approvals.listOpenApprovals(1);
    const answer = (decision) => approvals.answerApproval(cards()[0].id, 1, decision);
    return { audit, provider, ctx, window, exec, text, cards, answer };
};

test.afterEach(() => approvals._resetForTests());

test("an unknown target is probed without logging in and always gets a card with its fingerprint; after Einmal the key is pinned and every later run expects it", async (t) => {
    const env = setup(t);
    const first = env.exec({ command: "docker compose ps" });
    await until(() => env.cards().length === 1);
    const [card] = env.cards();
    assert.deepStrictEqual(
        [card.tool, card.access, card.target, card.command, card.allowSession, card.sshTarget, card.hostKey],
        ["ssh_exec", "exec", "web02 · deploy@10.0.0.12:22", "docker compose ps", false,
            { ref: "server:12", name: "web02", user: "deploy", host: "10.0.0.12", port: 22 },
            { algorithm: "ssh-ed25519", fingerprint: ssh.fp("web02"), new: true }]);
    assert.deepStrictEqual(ssh.world.opened.map((o) => [o.sessionType, o.host, o.port, o.params, o.options]),
        [[SessionType.SFTP, "10.0.0.12", 22, { username: "deploy" }, { probeHostKey: true }]]);
    assert.deepStrictEqual([ssh.world.logins, bed.state.secretReads], [[], 0]);

    env.answer("once");
    assert.strictEqual(env.text(await first), "exit 0\n--- stdout ---\nweb02: docker compose ps\n--- stderr ---\n");
    const run = ssh.world.opened[1];
    assert.deepStrictEqual([run.options, Object.keys(run.params).sort()],
        [{ expectedHostKey: ssh.fp("web02"), execOnly: true }, ["passphrase", "password", "privateKey", "username"]]);
    assert.deepStrictEqual([...ssh.world.closed].sort(), ssh.world.opened.map((o) => o.sessionId).sort(), "probe and run are closed");
    assert.deepStrictEqual([ssh.pinned(61, "server:12").fingerprint, ssh.pinned(61, "server:12").confirmedBy], [ssh.fp("web02"), 1]);
    const pinned = env.audit.find((entry) => entry.action === "vault.ssh_host_key_pinned");
    assert.deepStrictEqual([pinned.resourceId, pinned.details.target, pinned.details.algorithm, pinned.details.fingerprint],
        [61, "server:12", "ssh-ed25519", ssh.fp("web02")]);

    assert.strictEqual(env.text(await env.exec({ command: "uptime" })), "exit 0\n--- stdout ---\nweb02: uptime\n--- stderr ---\n");
    assert.strictEqual(ssh.world.opened.length, 3, "a pinned key needs no probe and the entry no card");
    assert.deepStrictEqual(ssh.world.logins.map((login) => login.expectedHostKey), [ssh.fp("web02"), ssh.fp("web02")]);
});

test("with allowSession a session approval covers further commands on the same target, not another target", async (t) => {
    const env = setup(t, { item: { approvalRequired: true }, fields: { allowSession: true }, pinned: [WEB02_KEY, NAS_KEY] });
    const first = env.exec({ command: "uptime" });
    await until(() => env.cards().length === 1);
    assert.deepStrictEqual([env.cards()[0].allowSession, env.cards()[0].hostKey], [true, undefined]);
    env.answer("session");
    await first;
    assert.ok(!(await env.exec({ command: "df -h" })).isError);
    assert.deepStrictEqual(env.cards(), []);

    const nas = env.exec({ target: "host:nas.lan:2222", command: "uptime" });
    await until(() => env.cards().length === 1);
    assert.deepStrictEqual([env.cards()[0].target, env.cards()[0].sshTarget.ref], ["nas.lan:2222 · deploy@nas.lan:2222", "host:nas.lan:2222"]);
    env.answer("once");
    assert.strictEqual(env.text(await nas), "exit 0\n--- stdout ---\nnas: uptime\n--- stderr ---\n");
});

test("without allowSession the card offers no session and an answer Für diese Sitzung counts once", async (t) => {
    const env = setup(t, { item: { approvalRequired: true }, pinned: [WEB02_KEY] });
    const first = env.exec({ command: "uptime" });
    await until(() => env.cards().length === 1);
    assert.strictEqual(env.cards()[0].allowSession, false);
    assert.deepStrictEqual(env.answer("session"), { status: 200 });
    assert.ok(!(await first).isError);

    const second = env.exec({ command: "uptime" });
    await until(() => env.cards().length === 1);
    env.answer("once");
    assert.ok(!(await second).isError);
});

test("a forgotten key gets the card with the new target again although a session approval for the same fingerprint still exists", async (t) => {
    const env = setup(t, { item: { approvalRequired: true }, fields: { allowSession: true }, pinned: [WEB02_KEY] });
    const first = env.exec({ command: "uptime" });
    await until(() => env.cards().length === 1);
    env.answer("session");
    await first;
    ssh.forget(61, "server:12");

    const again = env.exec({ command: "uptime" });
    await until(() => env.cards().length === 1);
    assert.deepStrictEqual(env.cards()[0].hostKey, { algorithm: "ssh-ed25519", fingerprint: ssh.fp("web02"), new: true });
    env.answer("once");
    assert.ok(!(await again).isError);
    assert.strictEqual(ssh.pinned(61, "server:12").fingerprint, ssh.fp("web02"));
});

test("a server entry moved to another machine: the engine refuses the pinned key before any login, vault.host_key_changed, audit with both fingerprints and a notice to the owner's windows only", async (t) => {
    const env = setup(t, { pinned: [WEB02_KEY] });
    const impersonation = openWindow(t, { impersonating: true });
    bed.state.entries.set(12, { ...WEB02, config: { ...WEB02.config, ip: "10.66.6.6" } });
    ssh.world.machines.set("10.66.6.6:22", ssh.machine("intruder"));

    const shown = env.text(await env.exec({ command: "id" }));
    assert.ok(shown.startsWith(`The host key of server:12 changed (expected ${ssh.fp("web02")}, got ${ssh.fp("intruder")})`), shown);
    assert.ok(shown.endsWith("(vault.host_key_changed)"), shown);
    assert.deepStrictEqual([ssh.world.logins, ssh.world.execs, env.cards()], [[], [], []]);
    assert.strictEqual(ssh.pinned(61, "server:12").fingerprint, ssh.fp("web02"), "the pinned key stays");
    const mismatch = env.audit.find((entry) => entry.action === "vault.ssh_host_key_mismatch");
    assert.deepStrictEqual([mismatch.details.target, mismatch.details.expected, mismatch.details.actual], ["server:12", ssh.fp("web02"), ssh.fp("intruder")]);
    assert.deepStrictEqual(env.window.notices(), [{ kind: "ssh_host_key_mismatch", item: "deploy", target: "server:12", name: "web02" }]);
    assert.deepStrictEqual(impersonation.notices(), []);

    assert.ok(env.text(await env.exec({ command: "id" })).endsWith("(vault.host_key_changed)"));
    assert.strictEqual(env.audit.filter((entry) => entry.action === "vault.ssh_host_key_mismatch").length, 2, "every call is audited");
    assert.strictEqual(env.window.notices().length, 1, "one toast a minute for the same key");
    assert.deepStrictEqual(ssh.world.logins, []);
    assert.ok(!JSON.stringify(env.audit).includes(PASSWORD));
});

test("a target removed while the card is open ends with vault.approval_stale; nothing logs in and no secret is read", async (t) => {
    const env = setup(t, { item: { approvalRequired: true }, pinned: [WEB02_KEY] });
    const pending = env.exec({ command: "uptime" });
    await until(() => env.cards().length === 1);
    bed.state.items[0].fields = { ...bed.state.items[0].fields, servers: [] };
    env.answer("once");

    assert.ok(env.text(await pending).endsWith("(vault.approval_stale)"));
    assert.deepStrictEqual([ssh.world.logins, bed.state.secretReads], [[], 0]);
});

test("refusals come before any card, connection or secret: wrong type, no targets, foreign target, bad command or timeout, missing rights, no engine", async (t) => {
    const API = { ...ITEM, id: 62, name: "api", type: "api_key", fields: { hosts: ["api.example.com"] } };
    const BARE = { ...ITEM, id: 63, name: "bare", fields: { username: "deploy", servers: [], hosts: [] } };
    const cases = [
        ["an API key entry", { item: "api" }, "vault.wrong_type"],
        ["an SSH entry without targets", { item: "bare" }, "vault.no_targets"],
        ["a server the entry does not list", { target: "server:13" }, "vault.target_not_allowed"],
        ["an empty command", { command: "" }, "vault.bad_command"],
        ["a command over 8 KB", { command: "x".repeat(8 * 1024 + 1) }, "vault.bad_command"],
        ["a command with a bidi override", { command: "ls \u202e-la" }, "vault.bad_command"],
        ["timeoutSec 1.5", { timeoutSec: 1.5 }, "vault.bad_timeout"],
        ["timeoutSec 601", { timeoutSec: 601 }, "vault.bad_timeout"],
        ["a server without connect.ssh of the account", {}, "vault.target_unavailable", () => bed.state.permissions.delete(Permission.CONNECT_SSH)],
        ["a free host without connect.direct of the account", { target: "host:nas.lan:2222" }, "vault.target_unavailable",
            () => bed.state.permissions.delete(Permission.CONNECT_DIRECT)],
        ["no engine connected", {}, "vault.ssh_failed", () => { ssh.world.engine = false; }],
    ];
    for (const [label, args, code, before] of cases) {
        const env = setup(t, { item: { approvalRequired: true }, extraItems: [API, BARE] });
        before?.();
        const shown = env.text(await env.exec({ command: "uptime", ...args }));
        assert.ok(shown.endsWith(`(${code})`), `${label}: ${shown}`);
        if (code === "vault.ssh_failed") assert.match(shown, /\(engine not connected\)/);
        assert.deepStrictEqual([ssh.world.opened, env.cards(), bed.state.secretReads], [[], [], 0], label);
    }
});

test("the output blanks password, passphrase and the key, a partial cat line by line; a timeout shows in the first line; the audit keeps command, exit code and sizes without secrets", async (t) => {
    const env = setup(t, { pinned: [WEB02_KEY] });
    const stdout = `${KEY}\n#\n${KEY.split("\n").slice(0, 3).join("\n")}\n`;
    const stderr = `sudo: ${PASSWORD} rejected; passphrase ${encodeURIComponent(PASSPHRASE)}\n[command timed out after 5 seconds]`;
    ssh.world.machines.get("10.0.0.12:22").run = () => ({ stdout, stderr, exitCode: 124, timedOut: true });
    const command = "cat ~/.ssh/id_ed25519; head -n 3 ~/.ssh/id_ed25519";

    assert.strictEqual(env.text(await env.exec({ command, timeoutSec: 5 })), [
        "exit 124 (timed out after 5 s)", "--- stdout ---", "••••", "#", "-----BEGIN OPENSSH PRIVATE KEY-----", "••••", "••••", "",
        "--- stderr ---", "sudo: •••• rejected; passphrase ••••", "[command timed out after 5 seconds]",
    ].join("\n"));
    assert.strictEqual(ssh.world.execs[0].timeoutMs, 5000);
    const use = env.audit.find((entry) => entry.action === "vault.use");
    assert.deepStrictEqual(
        [use.details.tool, use.details.access, use.details.target, use.details.host, use.details.port, use.details.user,
            use.details.command, use.details.exitCode, use.details.timedOut, use.details.bytes],
        ["ssh_exec", "exec", "server:12", "10.0.0.12", 22, "deploy", command, 124, true, Buffer.byteLength(stdout) + Buffer.byteLength(stderr)]);
    for (const secret of [PASSWORD, PASSPHRASE, KEY_LINES[0]]) assert.ok(!JSON.stringify(env.audit).includes(secret), secret);
});

test("a stream over 64 KB is cut on the limit without leaving the start of the password behind", async (t) => {
    const env = setup(t, { pinned: [WEB02_KEY] });
    ssh.world.machines.get("10.0.0.12:22").run = () => ({
        stdout: `${"a".repeat(65536 - 5)}${PASSWORD}${"b".repeat(100)}`, stderr: "", exitCode: 0, timedOut: false,
    });
    assert.strictEqual(env.text(await env.exec({ command: "cat big.log" })),
        `exit 0\n--- stdout ---\n${"a".repeat(65531)}\n[truncated after 65536 bytes]\n--- stderr ---\n`);
});

test("vault_list shows an SSH entry with its user, allowSession and only the targets the account may use, with hostKeyKnown; without a visible target no tool", async (t) => {
    const env = setup(t, { pinned: [WEB02_KEY], permissions: [Permission.VAULT_USE, Permission.CONNECT_SSH] });
    bed.state.entries.set(13, { ...WEB02, id: 13, name: "foreign", accountId: 2 });
    bed.state.items[0].fields = { ...bed.state.items[0].fields, servers: [12, 13] };
    const list = async () => JSON.parse(env.text(await env.provider.call("vault_list", {}, env.ctx)))[0];

    assert.deepStrictEqual(await list(), {
        item: "deploy", owner: "personal", type: "ssh", description: null, username: "deploy", allowSession: false,
        targets: [{ ref: "server:12", name: "web02", host: "10.0.0.12", port: 22, hostKeyKnown: true }],
        approvalRequired: false, usableBy: ["ssh_exec"],
    });
    bed.state.permissions.add(Permission.CONNECT_DIRECT);
    assert.deepStrictEqual((await list()).targets.map((target) => [target.ref, target.hostKeyKnown]), [["server:12", true], ["host:nas.lan:2222", false]]);
    bed.state.permissions = new Set([Permission.VAULT_USE]);
    const hidden = await list();
    assert.deepStrictEqual([hidden.targets, hidden.usableBy], [[], []]);
    assert.strictEqual(bed.state.secretReads, 0);
});

test("per key at most 2 runs at a time and 30 calls a minute: the third run is vault.busy without a session, an aborted run ends with vault.client_gone and closes its session, a failed run gives its slot back, the 31st call is vault.rate_limited", async (t) => {
    const env = setup(t, { pinned: [WEB02_KEY, NAS_KEY] });
    const web02 = ssh.world.machines.get("10.0.0.12:22");
    web02.run = () => new Promise(() => {});
    const aborts = [new AbortController(), new AbortController()];
    const hanging = aborts.map((controller) => env.exec({ command: "sleep 600" }, controller.signal));
    await until(() => ssh.world.execs.length === 2);

    assert.ok(env.text(await env.exec({ command: "uptime" })).endsWith("(vault.busy)"));
    assert.strictEqual(ssh.world.opened.length, 2, "the busy call opens no session");

    aborts[0].abort();
    assert.ok(env.text(await hanging[0]).endsWith("(vault.client_gone)"));
    assert.ok(ssh.world.closed.includes(ssh.world.opened[0].sessionId));
    const aborted = env.audit.find((entry) => entry.action === "vault.use_denied" && entry.details.code === "vault.client_gone");
    assert.strictEqual(aborted.details.commandSent, true);

    ssh.world.machines.set("nas.lan:2222", ssh.machine("nas", { accepts: () => false }));
    assert.match(env.text(await env.exec({ target: "host:nas.lan:2222", command: "uptime" })), /\(login refused\).*\(vault\.ssh_failed\)$/s);
    web02.run = (command) => ({ stdout: command, stderr: "", exitCode: 0, timedOut: false });
    for (let call = 5; call <= 30; call++) assert.ok(!(await env.exec({ command: "uptime" })).isError, `call ${call}`);

    const opened = ssh.world.opened.length;
    assert.ok(env.text(await env.exec({ command: "uptime" })).endsWith("(vault.rate_limited)"));
    assert.strictEqual(ssh.world.opened.length, opened);
    aborts[1].abort();
    await hanging[1];
});

test("a server target of an organization entry that now belongs to another organization is vault.target_unavailable before any connection", async (t) => {
    const env = setup(t, { item: { organizationId: 20 }, pinned: [WEB02_KEY] });
    bed.state.entries.set(12, { ...WEB02, accountId: null, organizationId: 20 });
    assert.ok(!(await env.exec({ item: "org:20/deploy", command: "uptime" })).isError);

    bed.state.entries.set(12, { ...WEB02, accountId: null, organizationId: 30 });
    const opened = ssh.world.opened.length;
    assert.ok(env.text(await env.exec({ item: "org:20/deploy", command: "uptime" })).endsWith("(vault.target_unavailable)"));
    assert.deepStrictEqual([ssh.world.opened.length, env.cards()], [opened, []]);
});

test("a connection that breaks after the command was sent says the command may have run; a command the engine never ran stays nothing was done", async (t) => {
    const env = setup(t, { pinned: [WEB02_KEY] });
    const web02 = ssh.world.machines.get("10.0.0.12:22");
    web02.run = () => Promise.reject(new Error("Connection closed"));
    assert.strictEqual(env.text(await env.exec({ command: "systemctl restart app" })),
        "The SSH connection to server:12 failed (connection); the command was sent and may have run in full or in part. Check on the target before running it again. (vault.ssh_failed)");
    web02.run = () => Promise.reject(new Error("Failed to execute command"));
    assert.strictEqual(env.text(await env.exec({ command: "systemctl restart app" })),
        "The SSH connection to server:12 failed (connection); nothing was done. (vault.ssh_failed)");
});

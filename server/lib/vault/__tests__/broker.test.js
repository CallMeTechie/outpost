const test = require("node:test");
const assert = require("node:assert");
const bed = require("./helpers/vaultBed");
const { VaultErrorCode } = require("../errors");
const { createBroker } = require("../broker");

const TOKEN = "ghp_broker-secret";
const API = {
    id: 42, accountId: 1, organizationId: null, name: "github-api", type: "api_key", description: null, updatedAt: "2026-10-10T08:00:00.000Z",
    fields: { hosts: ["api.github.com"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}" }, approvalRequired: true, allServers: true,
};

const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(condition(), "condition not reached");
};

const setup = () => {
    bed.reset({ items: [{ ...API }], secrets: { "42:token": TOKEN }, apiKeys: [99] });
    const open = [];
    const approvals = { requestApproval: (request) => new Promise((resolve) => { open.push({ request, answer: resolve }); }) };
    const audit = [];
    const acted = [];
    const broker = createBroker({ approvals, audit: async (entry) => { audit.push(entry); } });
    const ctx = {
        accountId: 1, keyId: 99, agent: null, impersonatorId: null, transportId: "A", ipAddress: "10.0.0.1", userAgent: "claude-code",
        signal: new AbortController().signal,
    };
    const use = () => broker.use({
        ctx, itemRef: "github-api", tool: "vault_http", access: "read", target: "GET api.github.com/user", field: "token",
        check: () => {},
        act: (secret) => {
            acted.push(secret);
            return "sent";
        },
    });
    return { open, audit, acted, use, broker, ctx };
};

const assertNothingDone = (env, code) => {
    assert.deepStrictEqual([env.acted, bed.state.secretReads], [[], 0], "neither read nor used");
    const denied = env.audit.find((entry) => entry.action === "vault.use_denied");
    assert.deepStrictEqual(
        [denied.resourceId, denied.details.code, denied.details.stage, denied.details.tool, denied.details.access, denied.details.target],
        [42, code, "after_approval", "vault_http", "read", "GET api.github.com/user"]);
    assert.ok(!env.audit.some((entry) => entry.action === "vault.use"));
};

test("the hosts of an entry change while its approval is open: vault.approval_stale, the value is never read and act never runs", async () => {
    const env = setup();
    const pending = env.use();
    await until(() => env.open.length === 1);
    bed.state.items[0].fields = { ...API.fields, hosts: ["api.github.com", "uploads.github.com"] };
    env.open[0].answer("once");

    await assert.rejects(pending, { code: VaultErrorCode.APPROVAL_STALE });
    assertNothingDone(env, VaultErrorCode.APPROVAL_STALE);
});

test("the key of the caller is revoked while the approval is open: vault.item_unknown, the value is never read and act never runs", async () => {
    const env = setup();
    const pending = env.use();
    await until(() => env.open.length === 1);
    bed.state.apiKeys.clear();
    env.open[0].answer("once");

    await assert.rejects(pending, { code: VaultErrorCode.ITEM_UNKNOWN });
    assertNothingDone(env, VaultErrorCode.ITEM_UNKNOWN);
});

test("forceApproval asks even where the entry needs no approval; like scope and card it is read after check(before), and the request skips session grants", async () => {
    const env = setup();
    bed.state.items[0].approvalRequired = false;
    const probe = { fingerprint: null };
    const run = (forceApproval) => env.broker.use({
        ctx: env.ctx, itemRef: "github-api", tool: "ssh_exec", access: "exec", lazySecret: true,
        check: (item, { phase }) => {
            if (phase === "before") probe.fingerprint = "SHA256:probed";
        },
        scope: () => `exec#server:12#${probe.fingerprint}`,
        forceApproval,
        card: () => ({ hostKey: { fingerprint: probe.fingerprint, new: true } }),
        act: () => "ran",
    });

    const forced = run(() => probe.fingerprint !== null);
    await until(() => env.open.length === 1);
    const { request } = env.open[0];
    assert.deepStrictEqual([request.scope, request.card, request.skipSessionGrant],
        ["exec#server:12#SHA256:probed", { hostKey: { fingerprint: "SHA256:probed", new: true } }, true]);
    env.open[0].answer("once");
    assert.strictEqual((await forced).result, "ran");

    assert.strictEqual((await run(false)).result, "ran");
    assert.strictEqual(env.open.length, 1, "without forceApproval the entry's switch decides");
});

test("username or allowSession change while the approval is open: vault.approval_stale, the value is never read and act never runs", async () => {
    for (const change of [{ username: "root" }, { allowSession: true }]) {
        const env = setup();
        bed.state.items[0].fields = { ...API.fields, username: "deploy", servers: [12], allowSession: false };
        const pending = env.use();
        await until(() => env.open.length === 1);
        bed.state.items[0].fields = { ...bed.state.items[0].fields, ...change };
        env.open[0].answer("once");

        await assert.rejects(pending, { code: VaultErrorCode.APPROVAL_STALE }, JSON.stringify(change));
        assertNothingDone(env, VaultErrorCode.APPROVAL_STALE);
    }
});

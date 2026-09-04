const test = require("node:test");
const assert = require("node:assert");
const { createSessionValidation } = require("../../validations/serverSession");
const { buildTransientEntry } = require("../../utils/directTarget");

// The validation is the first line of defence for a connection that has no
// entry behind it, so every rule it carries is asserted here rather than
// assumed. A one-off target skips per-entry access rules by construction; what
// keeps that honest is the permission check in the controller plus the shape
// rules below.

const ok = (body) => createSessionValidation.validate(body).error === undefined;

const creds = { type: "password", username: "u", password: "p" };
const target = { host: "example.com", port: 22, protocol: "ssh" };

test("a stored entry alone is accepted", () => {
    assert.ok(ok({ entryId: 1 }));
});

test("a one-off target with credentials is accepted", () => {
    assert.ok(ok({ directTarget: target, directIdentity: creds }));
});

test("entry and target together are refused", () => {
    assert.ok(!ok({ entryId: 1, directTarget: target, directIdentity: creds }));
});

test("neither entry nor target is refused", () => {
    assert.ok(!ok({ identityId: 3 }));
});

test("a target without credentials is refused", () => {
    // There is no stored identity to fall back on, so an unauthenticated
    // request here would reach the SSH layer with nothing to offer.
    assert.ok(!ok({ directTarget: target }));
});

test("a target cannot borrow a stored identity", () => {
    assert.ok(!ok({ directTarget: target, directIdentity: creds, identityId: 7 }));
});

test("a target carries no script and no tmux session", () => {
    for (const extra of [{ scriptId: 5 }, { tmuxSession: "main" }, { tmuxCreate: true }, { tmuxWindowId: "@1" }]) {
        assert.ok(!ok({ directTarget: target, directIdentity: creds, ...extra }),
            `expected refusal for ${JSON.stringify(extra)}`);
    }
});

test("a host that looks like a URL is refused", () => {
    // No scheme, no path, no credentials in the host string: a URL-shaped host
    // is a sign something is being smuggled past the field it belongs in.
    for (const host of ["ssh://example.com", "user@example.com", "example.com/x", "a b"]) {
        assert.ok(!ok({ directTarget: { ...target, host }, directIdentity: creds }),
            `expected refusal for host ${host}`);
    }
});

test("a hostname, an IPv4 and an IPv6 address are all accepted", () => {
    for (const host of ["example.com", "10.0.0.5", "fe80::1", "host-name.local"]) {
        assert.ok(ok({ directTarget: { ...target, host }, directIdentity: creds }),
            `expected acceptance for host ${host}`);
    }
});

test("the port has to be a real port", () => {
    for (const port of [0, 65536, -1, 1.5]) {
        assert.ok(!ok({ directTarget: { ...target, port }, directIdentity: creds }),
            `expected refusal for port ${port}`);
    }
    assert.ok(ok({ directTarget: { ...target, port: 65535 }, directIdentity: creds }));
});

test("only protocols a one-off connection can actually speak", () => {
    for (const protocol of ["ssh", "telnet"]) {
        assert.ok(ok({ directTarget: { ...target, protocol }, directIdentity: creds }));
    }
    // RDP, VNC and Proxmox need an entry: they carry engine and renderer
    // settings that a freely typed target cannot supply.
    for (const protocol of ["rdp", "vnc", "pve-lxc", "sftp"]) {
        assert.ok(!ok({ directTarget: { ...target, protocol }, directIdentity: creds }),
            `expected refusal for protocol ${protocol}`);
    }
});

test("the transient entry is shaped the way the connection path reads it", () => {
    const entry = buildTransientEntry({ host: "10.0.0.5", port: 2222, protocol: "ssh" });
    // These four reads are what the path below createSession actually performs.
    assert.strictEqual(entry.config.ip, "10.0.0.5");
    assert.strictEqual(entry.config.port, 2222);
    assert.strictEqual(entry.config.protocol, "ssh");
    assert.strictEqual(entry.type, "server");
    // "terminal", not "xterm": this is the value the client's renderer switch
    // knows (ViewContainer) and the one controllers/entry.js gives a plain SSH
    // entry. Getting it wrong renders "Unknown renderer" instead of a session.
    assert.strictEqual(entry.renderer, "terminal");
    // id stays null: it flows into the audit record and into SessionManager,
    // and a made-up number there would collide with a real entry.
    assert.strictEqual(entry.id, null);
    assert.strictEqual(entry.organizationId, null);
    assert.strictEqual(entry.name, "10.0.0.5:2222");
});

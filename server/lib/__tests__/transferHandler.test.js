const test = require("node:test");
const assert = require("node:assert");

// The handler factory takes its heavy dependencies through ctx.deps, which makes it testable
// without module mocking. The production path fills ctx.deps at the call site.
const { buildTransferHandlers } = require("../fileTransfer/transferHandlers");

const OP = { TRANSFER_ERROR: 0x16, TRANSFER_DONE: 0x15, TRANSFER_PROGRESS: 0x14, TRANSFER_CONFLICT: 0x18 };

const setup = (over = {}) => {
    const sent = [];
    const released = [];
    const transfers = new Map();
    const registry = { reserved: [], reserve(key) { this.reserved.push(key); return true; },
        release(key) { this.reserved = this.reserved.filter((k) => k !== key); },
        countFor() { return 0; } };
    const fakeTransfer = { run: () => new Promise(() => {}), cancel() { this.cancelled = true; } };

    const deps = {
        send: (op, data) => sent.push({ op, data }),
        registry,
        getConnection: () => ({ sftpClient: { stat: async () => ({ isDir: false }) } }),
        authorizeSource: async () => ({ sourceEntry: { id: "e-src" }, sourceScope: { organizationId: "o" } }),
        authorizeDestination: async () => ({ destScope: { organizationId: "o" } }),
        findEntry: async () => ({ id: "e-dst", organizationId: "o" }),
        getCrossClient: async () => ({}),
        releaseCrossClient: (_conn, id) => released.push(id),
        createAdapter: () => ({}),
        getCapabilities: () => ({ shell: true }),
        createTransfer: () => fakeTransfer,
        createAuditLog: () => {},
        ...over,
    };
    const ctx = { user: { id: "u" }, sessionId: "dst", serverSession: { entryId: "e-dst" },
        entry: { id: "e-dst" }, ipAddress: "1.1.1.1", userAgent: "t", transfers, deps };
    return { handlers: buildTransferHandlers(OP, ctx), sent, released, transfers, registry, fakeTransfer };
};

const start = (over = {}) => ({ transferId: "t1", sourceSessionId: "src", paths: ["/a"],
    destination: "/d", action: "copy", onConflict: "skip", ...over });

test("a valid request registers the transfer and starts it", async () => {
    const s = setup();
    await s.handlers.start(start());
    assert.strictEqual(s.transfers.size, 1);
    assert.deepStrictEqual(s.registry.reserved.length, 1);
});

// The name has to be taken before the first await, or two messages both pass the check.
test("two concurrent starts with the same id do not both register", async () => {
    const s = setup();
    await Promise.all([s.handlers.start(start()), s.handlers.start(start())]);
    assert.strictEqual(s.transfers.size, 1);
    assert.strictEqual(s.registry.reserved.length, 1, "the second must not reserve a slot too");
    assert.ok(s.sent.some((m) => m.op === OP.TRANSFER_ERROR), "the second must be told");
});

test("a refusal is reported as TRANSFER_ERROR with the transfer id", async () => {
    const err = new Error("Transfer not permitted");
    err.name = "TransferNotPermittedError";
    const s = setup({ authorizeSource: async () => { throw err; } });
    await s.handlers.start(start());
    const msg = s.sent.find((m) => m.op === OP.TRANSFER_ERROR);
    assert.ok(msg, "no TRANSFER_ERROR was sent");
    assert.strictEqual(msg.data.transferId, "t1");
});

test("a refusal leaves no slot and no register entry behind", async () => {
    const s = setup({ authorizeSource: async () => { throw new Error("Transfer not permitted"); } });
    await s.handlers.start(start());
    assert.strictEqual(s.transfers.size, 0);
    assert.strictEqual(s.registry.reserved.length, 0);
});

// Anything thrown between reserve and the finished entry must give the slot back.
test("a failure while building the transfer releases the slot", async () => {
    const s = setup({ createTransfer: () => { throw new Error("boom"); } });
    await s.handlers.start(start());
    assert.strictEqual(s.registry.reserved.length, 0, "slot leaked");
    assert.strictEqual(s.transfers.size, 0);
    assert.deepStrictEqual(s.released, ["t1", "t1"], "both aux clients must be released");
});

test("a full register is reported and reserves nothing", async () => {
    const s = setup();
    s.registry.reserve = () => false;
    await s.handlers.start(start());
    assert.strictEqual(s.transfers.size, 0);
    assert.ok(s.sent.some((m) => m.op === OP.TRANSFER_ERROR));
});

test("a failing source stat is refused without leaking the server text", async () => {
    const s = setup({ getConnection: () => ({ sftpClient: { stat: async () => { throw new Error("No such file /etc/shadow"); } } }) });
    await s.handlers.start(start());
    const msg = s.sent.find((m) => m.op === OP.TRANSFER_ERROR);
    assert.doesNotMatch(msg.data.message, /etc\/shadow/, "the source server text must not reach the client");
});

test("cancel reaches both the transfer and the conflict broker", async () => {
    const s = setup();
    await s.handlers.start(start());
    const entry = s.transfers.get("t1");
    let brokerCancelled = false;
    entry.broker = { cancel: () => { brokerCancelled = true; }, resolve: () => {} };
    s.handlers.cancel({ transferId: "t1" });
    assert.strictEqual(s.fakeTransfer.cancelled, true);
    assert.strictEqual(brokerCancelled, true, "a waiting conflict question must be released too");
});

test("cancel and resolve with an unknown id are ignored", () => {
    const s = setup();
    assert.doesNotThrow(() => s.handlers.cancel({ transferId: "nope" }));
    assert.doesNotThrow(() => s.handlers.resolve({ transferId: "nope", file: "a", choice: "skip" }));
});

test("resolve is forwarded to the broker of its own transfer", async () => {
    const s = setup();
    await s.handlers.start(start());
    const seen = [];
    s.transfers.get("t1").broker = { resolve: (r) => seen.push(r), cancel: () => {} };
    s.handlers.resolve({ transferId: "t1", file: "a.txt", choice: "overwrite" });
    assert.deepStrictEqual(seen, [{ transferId: "t1", file: "a.txt", choice: "overwrite" }]);
});

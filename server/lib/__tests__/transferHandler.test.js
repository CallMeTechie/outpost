const test = require("node:test");
const assert = require("node:assert");

// The handler factory takes its heavy dependencies through ctx.deps, which makes it testable
// without module mocking. The production path fills ctx.deps at the call site.
const { buildTransferHandlers } = require("../fileTransfer/transferHandlers");
const { cancelAllTransfers } = require("../../routes/sftpWS");

const OP = { TRANSFER_ERROR: 0x16, TRANSFER_DONE: 0x15, TRANSFER_PROGRESS: 0x14, TRANSFER_CONFLICT: 0x18 };

const setup = (over = {}, ctxOver = {}) => {
    const sent = [];
    const released = [];
    const transfers = new Map();
    const registry = { reserved: [], reserve(key) { this.reserved.push(key); return true; },
        release(key) { this.reserved = this.reserved.filter((k) => k !== key); },
        countFor() { return 0; }, MAX_CROSS_TRANSFERS: 2 };
    const fakeTransfer = { run: () => new Promise(() => {}), cancel() { this.cancelled = true; } };

    const deps = {
        send: (op, data) => sent.push({ op, data }),
        registry,
        getConnection: () => ({ sftpClient: { stat: async () => ({ isDir: false }) } }),
        authorizeSource: async () => ({ sourceEntry: { id: "e-src" }, sourceScope: { organizationId: "o" } }),
        authorizeDestination: async () => ({ destScope: { organizationId: "o" } }),
        // Echoes its argument, so which of the two entry ids the handler asks for stays visible.
        findEntry: async (id) => ({ id, organizationId: "o" }),
        getCrossClient: async () => ({}),
        releaseCrossClient: (_conn, id) => released.push(id),
        createAdapter: () => ({}),
        getCapabilities: () => ({ shell: true }),
        createTransfer: () => fakeTransfer,
        createAuditLog: () => {},
        ...over,
    };
    // The two entries differ on purpose: ctx.entry is the reduced one a shared socket carries.
    const ctx = { user: { id: "u" }, sessionId: "dst", serverSession: { entryId: "e-dst" },
        entry: { id: "e-shared" }, ipAddress: "1.1.1.1", userAgent: "t", transfers, deps, ...ctxOver };
    return { handlers: buildTransferHandlers(OP, ctx), sent, released, transfers, registry, fakeTransfer };
};

// A miniature of ConnectionService: the auxiliary client is cached ON THE CONNECTION it was opened
// for, under the key the handler passes in, and a release closes exactly that entry. Two
// destination sessions reaching for the same source is what makes that key's namespace matter.
const fakeConnectionService = () => {
    const conns = new Map();
    const connFor = (sessionId) => {
        if (!conns.has(sessionId)) {
            conns.set(sessionId, { sessionId, sftpClient: { stat: async () => ({ isDir: false }) },
                crossTransferClients: new Map() });
        }
        return conns.get(sessionId);
    };
    return {
        connFor,
        deps: {
            getConnection: connFor,
            getCrossClient: async (sessionId, entry, accountId, connectionKey) => {
                const cache = connFor(sessionId).crossTransferClients;
                if (!cache.has(connectionKey)) {
                    cache.set(connectionKey, { sessionId, entry, accountId, connectionKey, closed: false });
                }
                return cache.get(connectionKey);
            },
            releaseCrossClient: (conn, connectionKey) => {
                const client = conn?.crossTransferClients?.get(connectionKey);
                if (!client) return;
                client.closed = true;
                conn.crossTransferClients.delete(connectionKey);
            },
            createAdapter: (client) => client,
        },
    };
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
    assert.deepStrictEqual(s.released, ["dst:t1", "dst:t1"], "both aux clients must be released");
});

// Fix round 3, Finding 1: ConnectionService.js's CROSS_TRANSFER_CONNECT_TIMEOUT_MS makes
// getCrossClient reject once its deadline passes instead of hanging forever. From this handler's
// side that is just another setup failure — the existing catch branch already releases the slot
// and both aux clients for any thrown error here; a timeout does not need special-casing.
test("a cross-transfer connection attempt that times out is treated like any other setup failure", async () => {
    const s = setup({ getCrossClient: async () => { throw new Error("Timed out opening cross-transfer connection"); } });
    await s.handlers.start(start());
    assert.strictEqual(s.registry.reserved.length, 0, "the reserved slot must be released");
    assert.strictEqual(s.transfers.size, 0);
    assert.deepStrictEqual(s.released, ["dst:t1", "dst:t1"], "both aux clients must be released");
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

// The duplicate guard must refuse the second request, not disown the first: the running entry is
// what cancel() and the cleanup path look up.
test("a second start with a running id does not evict the running transfer", async () => {
    const s = setup();
    await s.handlers.start(start());
    await s.handlers.start(start());
    assert.strictEqual(s.transfers.size, 1, "the running transfer was evicted by its duplicate");
    assert.ok(s.transfers.get("t1")?.transfer, "the running entry must survive the duplicate");
});

// Losing the entry costs the run its source session, and finish() would then release only the
// destination client — the source aux connection would stay open for the rest of the session.
test("a second start with a running id costs the first no cleanup", async () => {
    let endRun;
    const s = setup({ createTransfer: () => ({ run: () => new Promise((r) => { endRun = r; }), cancel() {} }) });
    await s.handlers.start(start());
    await s.handlers.start(start());
    endRun({ files: 1 });
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(s.released, ["dst:t1", "dst:t1"], "the source aux client was never released");
    assert.strictEqual(s.registry.reserved.length, 0, "slot leaked");
});

// The stat sits behind the authorization chain on purpose: run before it, its outcome would turn
// sourceSessionId into an existence oracle over foreign hosts.
test("the source is never touched before the authorization chain ran", async () => {
    let statted = 0;
    const s = setup({
        authorizeSource: async () => { throw new Error("Transfer not permitted"); },
        getConnection: () => ({ sftpClient: { stat: async () => { statted += 1; return { isDir: false }; } } }),
    });
    await s.handlers.start(start());
    assert.strictEqual(statted, 0, "the source was probed for an unauthorized caller");
});

// sourceIsFolder decides whether the destination check demands FILES_MODIFY.
test("a folder among the source paths reaches the destination check", async () => {
    let seen = null;
    const s = setup({
        getConnection: () => ({ sftpClient: { stat: async () => ({ isDir: true }) } }),
        authorizeDestination: async (req) => { seen = req; return { destScope: { organizationId: "o" } }; },
    });
    await s.handlers.start(start());
    assert.strictEqual(seen.sourceIsFolder, true);
    assert.strictEqual(seen.onConflict, "skip", "the validated conflict mode must reach the check");
});

// On a shared socket ctx.entry carries a reduced attribute set without organizationId, and
// hasResourcePermission would then fall back to system-wide rights. The session's own entry is
// what the destination check must run on.
test("the destination entry is loaded from the server session, not from the socket", async () => {
    const asked = [];
    let checked = null;
    const s = setup({
        findEntry: async (id) => { asked.push(id); return { id, organizationId: id === "e-dst" ? "o" : undefined }; },
        authorizeDestination: async (request) => { checked = request.destEntry; return { destScope: { organizationId: "o" } }; },
    }, { serverSession: { entryId: "e-dst" }, entry: { id: "e-shared" } });
    await s.handlers.start(start());
    assert.deepStrictEqual(asked, ["e-dst"], "the reduced socket entry must not decide the destination");
    assert.deepStrictEqual(checked, { id: "e-dst", organizationId: "o" });
});

test("without a server session the socket's own entry is the fallback", async () => {
    const asked = [];
    const s = setup({ findEntry: async (id) => { asked.push(id); return { id, organizationId: "o" }; } },
        { serverSession: null, entry: { id: "e-shared" } });
    await s.handlers.start(start());
    assert.deepStrictEqual(asked, ["e-shared"]);
});

test("a destination entry that cannot be loaded is refused before anything is opened", async () => {
    let opened = 0;
    const s = setup({ findEntry: async () => null, getCrossClient: async () => { opened += 1; return {}; } });
    await s.handlers.start(start());
    assert.strictEqual(s.sent.find((m) => m.op === OP.TRANSFER_ERROR).data.message, "Transfer not permitted");
    assert.strictEqual(opened, 0, "no aux connection may be opened for an unloadable destination");
    assert.strictEqual(s.transfers.size, 0);
    assert.strictEqual(s.registry.reserved.length, 0);
});

// The identity decides which credentials may be used, so it must be the caller's, and the two
// entries must not be swapped between the two sides.
test("both aux clients are opened for the caller and for their own side", async () => {
    const calls = [];
    const s = setup({ getCrossClient: async (...args) => { calls.push(args); return {}; } });
    await s.handlers.start(start());
    assert.deepStrictEqual(calls, [
        ["src", { id: "e-src" }, "u", "dst:t1"],
        ["dst", { id: "e-dst", organizationId: "o" }, "u", "dst:t1"],
    ]);
});

// The register lets two destination sessions run the same client-chosen id against one source:
// reserve("dstA:t1") and reserve("dstB:t1") both succeed, and the source is only at its limit of
// two afterwards. So the id alone must never name the auxiliary connection on the source.
test("two destinations with the same transfer id do not share a source connection", async () => {
    const svc = fakeConnectionService();
    const deps = { ...svc.deps,
        createTransfer: () => ({ run: () => new Promise(() => {}), cancel() {} }) };
    const a = setup(deps, { sessionId: "dstA", user: { id: "u-a" } });
    const b = setup(deps, { sessionId: "dstB", user: { id: "u-b" } });
    await a.handlers.start(start());
    await b.handlers.start(start());

    const onSource = [...svc.connFor("src").crossTransferClients.values()];
    assert.strictEqual(onSource.length, 2, "the second destination was handed the first one's connection");
    assert.deepStrictEqual(onSource.map((c) => c.accountId), ["u-a", "u-b"],
        "a connection opened under one account must never be served to another");
});

test("releasing one destination's transfer leaves the other one's connection open", async () => {
    const svc = fakeConnectionService();
    const ends = [];
    const deps = { ...svc.deps,
        createTransfer: () => ({ run: () => new Promise((r) => ends.push(r)), cancel() {} }) };
    const a = setup(deps, { sessionId: "dstA", user: { id: "u-a" } });
    const b = setup(deps, { sessionId: "dstB", user: { id: "u-b" } });
    await a.handlers.start(start());
    await b.handlers.start(start());
    const sourceOfB = [...svc.connFor("src").crossTransferClients.values()].find((c) => c.accountId === "u-b");
    assert.ok(sourceOfB, "the second destination never got its own source connection");

    ends[0]({ files: 0 });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(sourceOfB.closed, false, "the first transfer's cleanup closed the other one's connection");
    assert.strictEqual(svc.connFor("src").crossTransferClients.size, 1, "exactly the finished one must be gone");
});

// Everything that hangs off the source session must read the same from outside.
test("a refusal never repeats what the failing dependency said", async () => {
    for (const boom of ["Session 7f3 does not exist", "No active SFTP session", "connect ECONNREFUSED 10.0.0.5:22"]) {
        const s = setup({ authorizeSource: async () => { throw new Error(boom); } });
        await s.handlers.start(start());
        assert.strictEqual(s.sent.find((m) => m.op === OP.TRANSFER_ERROR).data.message,
            "Transfer not permitted", `leaked: ${boom}`);
    }
});

test("the caller's own quota names itself", async () => {
    const s = setup();
    s.registry.reserve = () => false;
    s.registry.countFor = () => 2;
    await s.handlers.start(start());
    assert.match(s.sent.find((m) => m.op === OP.TRANSFER_ERROR).data.message, /^Too many/);
});

// Fix round 3, Finding 3: reducing the quota check to only the destination session (ctx.sessionId)
// and dropping the source-session check left every existing test green — the fake's default
// countFor(() => 0) never distinguishes which id is asked about, and "the caller's own quota names
// itself" above makes BOTH sides read as full at once. Here only the source is at its limit; the
// destination is empty. Must still report the quota, not a collision.
test("the source session's own full quota also names itself, not just the destination's", async () => {
    const s = setup();
    s.registry.reserve = () => false;
    s.registry.countFor = (id) => (id === "src" ? 2 : 0);
    await s.handlers.start(start());
    assert.match(s.sent.find((m) => m.op === OP.TRANSFER_ERROR).data.message, /^Too many/);
});

// Fix round 2, Finding "Kleineres": a key collision (the string was already reserved — typically a
// zombie transfer whose source vanished mid-run, see SessionManager.js#releaseSession) is not the
// caller's own quota being full. Neither session is anywhere near MAX_CROSS_TRANSFERS here
// (countFor stays 0, the default fake), yet reserve() still refuses — exactly what a shared
// destination session picking a colliding client-chosen id looks like from the handler's side.
test("a key collision is reported distinctly from the caller's own quota", async () => {
    const s = setup();
    s.registry.reserve = () => false;
    await s.handlers.start(start());
    assert.strictEqual(s.sent.find((m) => m.op === OP.TRANSFER_ERROR).data.message, "Transfer id already in use");
});

test("a malformed payload names itself and carries no transfer id", async () => {
    const s = setup();
    await s.handlers.start(start({ paths: [] }));
    const msg = s.sent.find((m) => m.op === OP.TRANSFER_ERROR);
    assert.strictEqual(msg.data.message, "Invalid transfer request");
    assert.strictEqual(msg.data.transferId, null);
    assert.strictEqual(s.registry.reserved.length, 0);
});

test("a refused attempt is audited with the path count only", async () => {
    const logged = [];
    const s = setup({ createAuditLog: (e) => logged.push(e),
        authorizeSource: async () => { throw new Error("Transfer not permitted"); } });
    await s.handlers.start(start({ paths: ["/secret/a", "/secret/b"] }));
    assert.strictEqual(logged.length, 1, "a refusal must leave a trail");
    assert.strictEqual(logged[0].details.refused, true);
    assert.strictEqual(logged[0].details.paths, 2, "paths belong in the trail as a count");
    assert.doesNotMatch(JSON.stringify(logged[0]), /secret/, "no attacker-chosen strings in the trail");
});

test("a started transfer is audited on both sides", async () => {
    const logged = [];
    const s = setup({ createAuditLog: (e) => logged.push(e) });
    await s.handlers.start(start());
    assert.strictEqual(logged.length, 2);
    assert.deepStrictEqual(logged.map((e) => e.details.refused), [undefined, undefined]);
});

test("a finished run reports, frees the entry and releases both aux clients", async () => {
    let endRun = null;
    let runArgs = null;
    let opts = null;
    const s = setup({ createTransfer: (o) => { opts = o; return {
        run: (...args) => { runArgs = args; return new Promise((r) => { endRun = r; }); }, cancel() {} }; } });
    await s.handlers.start(start());
    assert.deepStrictEqual(runArgs, [["/a"], "/d", { action: "copy", onConflict: "skip" }]);

    opts.onProgress({ bytesDone: 1 });
    endRun({ files: 1 });
    await new Promise((r) => setImmediate(r));

    assert.deepStrictEqual(s.sent.find((m) => m.op === OP.TRANSFER_DONE).data, { transferId: "t1", files: 1 });
    const progress = s.sent.filter((m) => m.op === OP.TRANSFER_PROGRESS);
    assert.strictEqual(progress.length, 2, "the last frame is flushed past the throttle");
    assert.ok(progress.every((m) => m.data.transferId === "t1"));
    assert.strictEqual(s.transfers.size, 0);
    assert.strictEqual(s.registry.reserved.length, 0);
    assert.deepStrictEqual(s.released, ["dst:t1", "dst:t1"]);
});

// Regression for fix round 1, Finding 1: sftpWS.js#cancelAllTransfers used to delete every entry
// from `transfers` on ws.on("close"), including running ones. finish() (above) reads
// transfers.get(transferId) to recover sourceSessionId before deleting it itself — with the entry
// already gone, that read comes back empty and only the destination side's aux client is ever
// released, leaking the source side's connection (and its engine session) for the rest of the
// source session's lifetime.
test("closing the socket while a transfer is running still releases both aux clients once it ends", async () => {
    const svc = fakeConnectionService();
    let endRun = null;
    const deps = { ...svc.deps,
        createTransfer: () => ({ run: () => new Promise((r) => { endRun = r; }), cancel() {} }) };
    const s = setup(deps);
    await s.handlers.start(start());

    const sourceClients = () => [...svc.connFor("src").crossTransferClients.values()];
    const destClients = () => [...svc.connFor("dst").crossTransferClients.values()];
    assert.strictEqual(sourceClients().length, 1, "setup must have opened the source's aux client");
    assert.strictEqual(destClients().length, 1, "setup must have opened the destination's aux client");

    // The socket closes while the transfer is still running.
    cancelAllTransfers(s.transfers);
    assert.strictEqual(s.transfers.size, 1,
        "a running entry must stay in the map — only its own finish() may remove it");

    endRun({ files: 1 });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(s.transfers.size, 0, "finish() removes the entry once the run actually ends");
    assert.strictEqual(sourceClients().length, 0, "the source's aux client leaked");
    assert.strictEqual(destClients().length, 0, "the destination's aux client leaked");
});

test("a failing run is reported with its leftovers and cleans up just the same", async () => {
    let failRun = null;
    const s = setup({ createTransfer: () => ({
        run: () => new Promise((_, reject) => { failRun = reject; }), cancel() {} }) });
    await s.handlers.start(start());
    const err = new Error("engine gave up");
    err.leftovers = ["/d/x"];
    err.sourceLeftovers = ["/a/y"];
    failRun(err);
    await new Promise((r) => setImmediate(r));

    assert.deepStrictEqual(s.sent.find((m) => m.op === OP.TRANSFER_ERROR).data,
        { transferId: "t1", message: "engine gave up", leftovers: ["/d/x"], sourceLeftovers: ["/a/y"] });
    assert.strictEqual(s.transfers.size, 0);
    assert.strictEqual(s.registry.reserved.length, 0);
    assert.deepStrictEqual(s.released, ["dst:t1", "dst:t1"]);
});

// A run can end for reasons the client never answered for; the open question is a plain in-memory
// promise with a 120 s timer that nothing else would ever reach.
test("an open conflict question is released when the run ends", async () => {
    let endRun = null;
    let opts = null;
    const s = setup({ createTransfer: (o) => { opts = o; return {
        run: () => new Promise((r) => { endRun = r; }), cancel() {} }; } });
    await s.handlers.start(start());
    const broker = s.transfers.get("t1").broker;

    const answer = opts.onConflict({ file: "a.txt" });
    assert.deepStrictEqual(s.sent.find((m) => m.op === OP.TRANSFER_CONFLICT).data,
        { transferId: "t1", file: "a.txt" });

    endRun({ files: 0 });
    const outcome = await Promise.race([answer, new Promise((r) => setImmediate(() => r("still open")))]);
    broker.cancel();
    assert.strictEqual(outcome, "abort", "the question outlived its run");
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

// A cancel arriving while the entry is still being built is dropped on purpose. The guard has to
// be on the transfer, not merely on the entry: the placeholder has no transfer, and reaching into
// it would throw a TypeError out into the dispatcher instead of a TRANSFER_ERROR.
test("a cancel during construction is dropped, not thrown", async () => {
    let release = null;
    let calls = 0;
    const s = setup({ getCrossClient: async () => {
        if (++calls === 1) await new Promise((r) => { release = r; });
        return {};
    } });
    const started = s.handlers.start(start());
    await new Promise((r) => setImmediate(r));

    assert.ok(s.transfers.get("t1"), "the placeholder must be in place for this test to mean anything");
    assert.strictEqual(s.transfers.get("t1").transfer, undefined, "still under construction");
    assert.doesNotThrow(() => s.handlers.cancel({ transferId: "t1" }));

    release();
    await started;
    assert.ok(s.transfers.get("t1")?.transfer, "the run starts regardless — the cancel was dropped");
});

// Nothing observes the run's promise chain, so a throw out of the reporting must not become an
// unhandled rejection. A closed socket throwing inside send() is the realistic trigger.
test("a throwing send at the end of a run stays inside the chain", async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
        let failRun = null;
        const s = setup({
            send: (op) => { if (op === OP.TRANSFER_ERROR) throw new Error("socket gone"); },
            createTransfer: () => ({ run: () => new Promise((_, reject) => { failRun = reject; }), cancel() {} }),
        });
        await s.handlers.start(start());
        failRun(new Error("engine gave up"));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        assert.deepStrictEqual(unhandled.map((e) => e.message), [], "the chain leaked a rejection");
        assert.strictEqual(s.transfers.size, 0, "the cleanup must still have run");
        assert.strictEqual(s.registry.reserved.length, 0);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
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

const test = require("node:test");
const assert = require("node:assert");
const { buildTransferHandlers } = require("../fileTransfer/transferHandlers");
// WIRE_OP is the real opcode table. It cannot be called OP here: the fixture below already binds
// that name to the four-opcode stub the transfer handlers are built against, and a second `const OP`
// in this module scope is a SyntaxError.
const { OP: WIRE_OP, cancelAllTransfers } = require("../../routes/sftpWS");
const { createMessageDispatch, createCloseHandler, createClose } = require("../../routes/oneDriveWS");
const { MicrosoftDisconnectedError } = require("../microsoft/errors");

const OP = { TRANSFER_ERROR: 0x16, TRANSFER_DONE: 0x15, TRANSFER_PROGRESS: 0x14, TRANSFER_CONFLICT: 0x18 };

// The same shape sftpWS builds, but for a socket whose own endpoint is a OneDrive connection:
// no entry, no serverSession, no sftpClient anywhere.
const setup = (over = {}) => {
    const sent = [];
    const transfers = new Map();
    const asked = { destinations: [], entries: 0 };

    const side = (scope) => ({
        scope, entry: null, probe: async () => ({ type: "file" }),
        acquire: async () => ({}), release: () => {},
    });

    const deps = {
        send: (op, data) => sent.push({ op, data }),
        registry: { reserve: () => true, release: () => {}, countFor: () => 0, MAX_CROSS_TRANSFERS: 2 },
        findEntry: async (id) => { asked.entries += 1; return { id, organizationId: "o" }; },
        resolveSource: async () => side({ organizationId: "o" }),
        resolveDestination: async (request) => { asked.destinations.push(request.endpoint); return side({ organizationId: null }); },
        createTransfer: () => ({ run: () => new Promise(() => {}), cancel() { this.cancelled = true; } }),
        createAuditLog: () => {},
        ...over,
    };

    const ctx = {
        user: { id: "u" }, transfers, deps, ipAddress: "1.1.1.1", userAgent: "t",
        endpoint: { kind: "onedrive", connectionId: 7, driveId: "me" },
    };

    return { handlers: buildTransferHandlers(OP, ctx), sent, transfers, asked };
};

const start = () => ({ transferId: "t1", sourceSessionId: "src", destination: "/Ziel", paths: ["/a.txt"] });

test("a transfer into OneDrive resolves the socket's own connection as the destination", async () => {
    const s = setup();

    await s.handlers.start(start());

    assert.deepStrictEqual(s.asked.destinations[0], { kind: "onedrive", connectionId: 7, driveId: "me" });
});

// A OneDrive socket has no entry to load, and reaching for ctx.entry would throw where the SFTP
// socket merely reads a reduced record.
test("the destination side of a OneDrive socket needs no entry", async () => {
    const s = setup();

    await s.handlers.start(start());

    assert.strictEqual(s.asked.entries, 0, "no entry may be loaded for a OneDrive destination");
    assert.ok(!s.sent.some((m) => m.op === OP.TRANSFER_ERROR), "the transfer must not have been refused");
});

// The same guarantee the SFTP socket gives: a socket that goes away does not leave a transfer
// running against a destination nobody is watching.
test("closing the socket cancels what is still running", async () => {
    const s = setup();
    await s.handlers.start(start());

    cancelAllTransfers(s.transfers);

    const entry = [...s.transfers.values()][0];
    assert.ok(entry.cancelled || entry.transfer?.cancelled, "the running transfer must have been marked");
});

// The three tests above build the transfer handlers directly and never pass through oneDriveWS.js.
// The ones below guard the route's own wiring — the places that silently stop working if anyone
// drops them.
const frame = (opCode, payload) => Buffer.concat([Buffer.from([opCode]), Buffer.from(JSON.stringify(payload))]);

test("the three transfer opcodes reach the transfer handlers, not the browse table", async () => {
    const seen = [];
    const dispatch = createMessageDispatch({
        handlers: { [WIRE_OP.LIST_FILES]: async () => seen.push("list") },
        transferHandlers: {
            start: async (p) => seen.push(["start", p.transferId]),
            cancel: async (p) => seen.push(["cancel", p.transferId]),
            resolve: async (p) => seen.push(["resolve", p.transferId]),
        },
        send: () => {},
    });

    await dispatch(frame(WIRE_OP.TRANSFER_START, { transferId: "t1" }));
    await dispatch(frame(WIRE_OP.TRANSFER_CANCEL, { transferId: "t1" }));
    await dispatch(frame(WIRE_OP.TRANSFER_RESOLVE, { transferId: "t1" }));
    await dispatch(frame(WIRE_OP.LIST_FILES, { path: "/" }));

    assert.deepStrictEqual(seen, [["start", "t1"], ["cancel", "t1"], ["resolve", "t1"], "list"]);
});

// An uncaught throw here escapes the async listener, and this codebase turns that into process.exit.
test("a throw from a transfer handler reaches the client as an error", async () => {
    const sent = [];
    const dispatch = createMessageDispatch({
        handlers: {},
        transferHandlers: { start: async () => { throw new Error("nope"); }, cancel: async () => {}, resolve: async () => {} },
        send: (op, data) => sent.push({ op, data }),
    });

    await dispatch(frame(WIRE_OP.TRANSFER_START, { transferId: "t1" }));

    assert.deepStrictEqual(sent, [{ op: WIRE_OP.ERROR, data: { message: "nope" } }]);
});

// Acceptance point 11 leaves the pane open while consent is withdrawn. The pane's message about
// the account page hangs off close code 4403 alone, and nothing closes this socket on its own — so
// an OP.ERROR here would show Microsoft's English developer prose as a toast instead, on the very
// path the spec requires to say the same thing as a fresh connection attempt.
test("a disconnected account closes the socket with 4403 instead of answering with an error", async () => {
    const sent = [];
    const closed = [];
    const dispatch = createMessageDispatch({
        handlers: { [WIRE_OP.LIST_FILES]: async () => { throw new MicrosoftDisconnectedError("Microsoft rejected the stored refresh token"); } },
        transferHandlers: { start: async () => { throw new MicrosoftDisconnectedError("gone"); }, cancel: async () => {}, resolve: async () => {} },
        send: (op, data) => sent.push({ op, data }),
        close: (code, reason) => closed.push([code, reason]),
    });

    await dispatch(frame(WIRE_OP.LIST_FILES, { path: "/" }));
    await dispatch(frame(WIRE_OP.TRANSFER_START, { transferId: "t1" }));

    assert.deepStrictEqual(sent, [], "nothing may be sent on a socket that is being closed");
    assert.deepStrictEqual(closed, [
        [4403, "This Microsoft connection is not available"],
        [4403, "This Microsoft connection is not available"],
    ]);
});

test("nothing is closed on a socket that is no longer open", () => {
    let closes = 0;
    createClose({ readyState: 3, close: () => { closes += 1; } })(4403, "gone");

    assert.strictEqual(closes, 0);
});

test("a socket that throws on close does not take the process down", () => {
    const close = createClose({ readyState: 1, close: () => { throw new Error("socket gone"); } });

    assert.doesNotThrow(() => close(4403, "gone"));
});

test("closing the socket cancels every transfer still running", () => {
    // The entries are held by reference on purpose: cancelAllTransfers DELETES a bare placeholder
    // from the map after marking it, so iterating the map afterwards would walk an empty map and
    // assert nothing at all.
    const entries = [{ pending: true }, { pending: true }];
    const transfers = new Map([["t1", entries[0]], ["t2", entries[1]]]);

    createCloseHandler(transfers)();

    for (const entry of entries) assert.ok(entry.cancelled, "every pending entry must be marked");
});

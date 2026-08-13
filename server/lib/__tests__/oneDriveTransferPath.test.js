const test = require("node:test");
const assert = require("node:assert");
const { buildTransferHandlers } = require("../fileTransfer/transferHandlers");
const { cancelAllTransfers } = require("../../routes/sftpWS");

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

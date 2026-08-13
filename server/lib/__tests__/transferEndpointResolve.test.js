const test = require("node:test");
const assert = require("node:assert");
const { resolveSource, resolveDestination } = require("../fileTransfer/endpoints");
const { TransferNotPermittedError } = require("../fileTransfer/transferErrors");

const user = { id: 5 };

const deps = (overrides = {}) => ({
    authorizeSource: async () => ({ sourceEntry: { id: 11 }, sourceScope: { organizationId: 3 } }),
    authorizeDestination: async () => ({ destScope: { organizationId: 4 } }),
    getConnection: () => ({ sftpClient: { stat: async () => ({ isDir: true }) } }),
    findEntry: async () => ({ id: 11 }),
    getCrossClient: async () => ({ marker: "sftp-client" }),
    releaseCrossClient: () => {},
    createSftpAdapter: (client) => ({ marker: "sftp-adapter", client }),
    getCapabilities: () => ({ shell: true }),
    loadConnection: async () => ({ id: 7, accountId: 5, status: "connected" }),
    createOneDriveAdapter: ({ connectionId }) => ({ marker: "onedrive-adapter", connectionId }),
    ...overrides,
});

test("an sftp source goes through the existing chain untouched", async () => {
    const seen = [];
    const resolved = await resolveSource(deps({
        authorizeSource: async (request) => { seen.push(request); return { sourceEntry: { id: 11 }, sourceScope: { organizationId: 3 } }; },
    }), { user, endpoint: { kind: "sftp", sessionId: "s1" }, action: "move" });

    assert.deepStrictEqual(seen[0], { user, sourceSessionId: "s1", action: "move" });
    assert.strictEqual(resolved.scope.organizationId, 3);
    assert.strictEqual(resolved.entry.id, 11);
});

test("a onedrive source is a personal resource with no organization", async () => {
    const resolved = await resolveSource(deps(), { user, endpoint: { kind: "onedrive", connectionId: 7, driveId: "me" }, action: "copy" });

    assert.deepStrictEqual(resolved.scope, { organizationId: null });
    assert.strictEqual(resolved.entry, null);
});

// The one question a OneDrive endpoint asks.
test("a connection belonging to somebody else is refused", async () => {
    await assert.rejects(
        resolveSource(deps({ loadConnection: async () => ({ id: 7, accountId: 6, status: "connected" }) }),
            { user, endpoint: { kind: "onedrive", connectionId: 7 }, action: "copy" }),
        TransferNotPermittedError);
});

test("a disconnected connection is refused", async () => {
    await assert.rejects(
        resolveSource(deps({ loadConnection: async () => ({ id: 7, accountId: 5, status: "disconnected" }) }),
            { user, endpoint: { kind: "onedrive", connectionId: 7 }, action: "copy" }),
        TransferNotPermittedError);
});

// A foreign id must not be distinguishable from one that does not exist.
test("a connection that does not exist is refused the same way", async () => {
    const foreign = resolveSource(deps({ loadConnection: async () => ({ id: 7, accountId: 6, status: "connected" }) }),
        { user, endpoint: { kind: "onedrive", connectionId: 7 }, action: "copy" });
    const missing = resolveSource(deps({ loadConnection: async () => null }),
        { user, endpoint: { kind: "onedrive", connectionId: 8 }, action: "copy" });

    const messages = await Promise.all([
        foreign.then(() => null, (error) => error.message),
        missing.then(() => null, (error) => error.message),
    ]);

    assert.strictEqual(messages[0], messages[1]);
    assert.strictEqual(messages[0], "Transfer not permitted");
});

test("a caller without a resolved identity is refused", async () => {
    for (const who of [null, undefined, {}, { id: null }]) {
        await assert.rejects(resolveSource(deps(), { user: who, endpoint: { kind: "onedrive", connectionId: 7 }, action: "copy" }),
            TransferNotPermittedError, `accepted ${JSON.stringify(who)}`);
    }
});

test("the sftp probe reports a folder through the session's own client", async () => {
    const resolved = await resolveSource(deps(), { user, endpoint: { kind: "sftp", sessionId: "s1" }, action: "copy" });

    assert.deepStrictEqual(await resolved.probe("/srv/dir"), { type: "folder" });
});

test("the sftp probe reports null rather than throwing for something that is not there", async () => {
    const resolved = await resolveSource(deps({
        getConnection: () => ({ sftpClient: { stat: async () => { throw new Error("no such file"); } } }),
    }), { user, endpoint: { kind: "sftp", sessionId: "s1" }, action: "copy" });

    assert.strictEqual(await resolved.probe("/srv/gone"), null);
});

test("the onedrive probe reports a folder through an adapter", async () => {
    const resolved = await resolveSource(deps({
        createOneDriveAdapter: () => ({ stat: async () => ({ type: "folder" }) }),
    }), { user, endpoint: { kind: "onedrive", connectionId: 7 }, action: "copy" });

    assert.deepStrictEqual(await resolved.probe("/Ordner"), { type: "folder" });
});

test("acquiring an sftp adapter opens an auxiliary client under the transfer's own key", async () => {
    const seen = [];
    const resolved = await resolveSource(deps({
        getCrossClient: async (...args) => { seen.push(args); return { marker: "sftp-client" }; },
    }), { user, endpoint: { kind: "sftp", sessionId: "s1" }, action: "copy" });

    const adapter = await resolved.acquire("key-1");

    assert.strictEqual(adapter.marker, "sftp-adapter");
    assert.deepStrictEqual(seen[0], ["s1", { id: 11 }, 5, "key-1"]);
});

// A OneDrive adapter is a value, not a connection: nothing to open and nothing to hand back.
test("acquiring a onedrive adapter opens nothing", async () => {
    let opened = 0;
    const resolved = await resolveSource(deps({ getCrossClient: async () => { opened += 1; return {}; } }),
        { user, endpoint: { kind: "onedrive", connectionId: 7 }, action: "copy" });

    const adapter = await resolved.acquire("key-1");

    assert.strictEqual(adapter.marker, "onedrive-adapter");
    assert.strictEqual(adapter.connectionId, 7);
    assert.strictEqual(opened, 0);
});

test("releasing an sftp endpoint hands the auxiliary client back", async () => {
    const released = [];
    const resolved = await resolveSource(deps({ releaseCrossClient: (conn, key) => released.push(key) }),
        { user, endpoint: { kind: "sftp", sessionId: "s1" }, action: "copy" });

    resolved.release("key-1");

    assert.deepStrictEqual(released, ["key-1"]);
});

test("releasing a onedrive endpoint is a no-op that cannot throw", async () => {
    const resolved = await resolveSource(deps({ releaseCrossClient: () => { throw new Error("must not be called"); } }),
        { user, endpoint: { kind: "onedrive", connectionId: 7 }, action: "copy" });

    resolved.release("key-1");
});

test("an sftp destination goes through the existing chain untouched", async () => {
    const seen = [];
    const resolved = await resolveDestination(deps({
        authorizeDestination: async (request) => { seen.push(request); return { destScope: { organizationId: 4 } }; },
    }), { user, endpoint: { kind: "sftp", sessionId: "d1" }, destEntry: { id: 22 }, onConflict: "ask", sourceIsFolder: true });

    assert.deepStrictEqual(seen[0], { user, destSessionId: "d1", destEntry: { id: 22 }, onConflict: "ask", sourceIsFolder: true });
    assert.strictEqual(resolved.scope.organizationId, 4);
});

test("a onedrive destination asks the same single question as a onedrive source", async () => {
    const resolved = await resolveDestination(deps(), { user, endpoint: { kind: "onedrive", connectionId: 7 }, onConflict: "ask", sourceIsFolder: false });

    assert.deepStrictEqual(resolved.scope, { organizationId: null });

    await assert.rejects(
        resolveDestination(deps({ loadConnection: async () => ({ id: 7, accountId: 6, status: "connected" }) }),
            { user, endpoint: { kind: "onedrive", connectionId: 7 }, onConflict: "ask", sourceIsFolder: false }),
        TransferNotPermittedError);
});

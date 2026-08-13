const test = require("node:test");
const assert = require("node:assert");
const { parseEndpoint, endpointKey, describeEndpoint, ENDPOINT_KINDS } = require("../fileTransfer/endpoints");

test("an sftp endpoint keeps its session id", () => {
    assert.deepStrictEqual(parseEndpoint({ kind: "sftp", sessionId: "abc" }), { kind: "sftp", sessionId: "abc" });
});

test("a onedrive endpoint keeps its connection and drive", () => {
    assert.deepStrictEqual(parseEndpoint({ kind: "onedrive", connectionId: 7, driveId: "me" }),
        { kind: "onedrive", connectionId: 7, driveId: "me" });
});

test("driveId defaults to the only drive this project addresses", () => {
    assert.strictEqual(parseEndpoint({ kind: "onedrive", connectionId: 7 }).driveId, "me");
});

// The field exists so shared libraries are not a protocol change later. Until then only one value
// is real, and anything else is a request for something that does not exist yet.
test("any other drive is refused", () => {
    assert.throws(() => parseEndpoint({ kind: "onedrive", connectionId: 7, driveId: "b!xyz" }), /Invalid/);
});

test("an unknown kind is refused", () => {
    for (const kind of ["ftp", "", null, 42, "SFTP"]) {
        assert.throws(() => parseEndpoint({ kind, sessionId: "a" }), /Invalid/, `accepted ${JSON.stringify(kind)}`);
    }
});

test("a missing or malformed session id is refused", () => {
    for (const sessionId of ["", null, 42, {}, undefined]) {
        assert.throws(() => parseEndpoint({ kind: "sftp", sessionId }), /Invalid/, `accepted ${JSON.stringify(sessionId)}`);
    }
});

// The connection id addresses a row and becomes part of a registry key; anything but a positive
// whole number is a caller bug, not a value to coerce.
test("a connection id that is not a positive whole number is refused", () => {
    for (const connectionId of [0, -1, 1.5, "7", null, undefined, NaN, {}]) {
        assert.throws(() => parseEndpoint({ kind: "onedrive", connectionId }), /Invalid/,
            `accepted ${JSON.stringify(connectionId)}`);
    }
});

test("a payload that is not an object at all is refused", () => {
    for (const raw of [null, undefined, "sftp", 42, []]) {
        assert.throws(() => parseEndpoint(raw), /Invalid/, `accepted ${JSON.stringify(raw)}`);
    }
});

test("nothing beyond the known fields survives parsing", () => {
    const parsed = parseEndpoint({ kind: "sftp", sessionId: "abc", accountId: 99, sftpClient: {} });

    assert.deepStrictEqual(Object.keys(parsed).sort(), ["kind", "sessionId"]);
});

test("the registry key of an sftp endpoint is its session id, unchanged from before", () => {
    assert.strictEqual(endpointKey({ kind: "sftp", sessionId: "abc" }), "abc");
});

// Prefixed so a connection id can never collide with a session id in the shared register.
test("the registry key of a onedrive endpoint is prefixed", () => {
    assert.strictEqual(endpointKey({ kind: "onedrive", connectionId: 7, driveId: "me" }), "onedrive:7");
});

test("the audit description names the kind and never leaks an object", () => {
    assert.deepStrictEqual(describeEndpoint({ kind: "sftp", sessionId: "abc" }), { kind: "sftp", sessionId: "abc" });
    assert.deepStrictEqual(describeEndpoint({ kind: "onedrive", connectionId: 7, driveId: "me" }),
        { kind: "onedrive", connectionId: 7, driveId: "me" });
});

test("both kinds are named in ENDPOINT_KINDS", () => {
    assert.deepStrictEqual([...ENDPOINT_KINDS].sort(), ["onedrive", "sftp"]);
});

const test = require("node:test");
const assert = require("node:assert");
const { validateTransferStart } = require("../fileTransfer/transferAuth");

const ok = { transferId: "t1", sourceSessionId: "s1", paths: ["/a"], destination: "/d", action: "copy" };
const DST = "d1";

test("a complete payload passes and defaults onConflict to ask", () => {
    assert.strictEqual(validateTransferStart(ok, DST).onConflict, "ask");
});

test("action defaults to copy", () => {
    const { action, ...rest } = ok;
    assert.strictEqual(validateTransferStart(rest, DST).action, "copy");
});

for (const field of ["transferId", "sourceSessionId", "destination"]) {
    test(`a missing ${field} is refused`, () => {
        assert.throws(() => validateTransferStart({ ...ok, [field]: undefined }, DST), /invalid/i);
    });
}

test("empty paths are refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, paths: [] }, DST), /invalid/i);
});

test("an unknown action is refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, action: "teleport" }, DST), /invalid/i);
});

// onConflict decides whether FILES_MODIFY is required — it must never be silently defaulted away.
test("an unknown conflict mode is refused rather than defaulted", () => {
    assert.throws(() => validateTransferStart({ ...ok, onConflict: "yolo" }, DST), /conflict/i);
});

test("a non-string transferId is refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, transferId: 7 }, DST), /invalid/i);
});

// Source == destination makes both auxiliary clients resolve to the same connection, which
// deadlocks the transfer — refuse it before anything is reserved.
test("a transfer onto its own session is refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, sourceSessionId: DST }, { kind: "sftp", sessionId: DST }),
        /invalid/i);
});

test("a transferId with unexpected characters is refused", () => {
    for (const id of ["a:b", "__proto__", "a/b", "x".repeat(65), ""]) {
        assert.throws(() => validateTransferStart({ ...ok, transferId: id }, DST), /invalid/i, `accepted ${id}`);
    }
});

test("a sane transferId passes", () => {
    for (const id of ["t1", "A-b_9", "x".repeat(64)]) {
        assert.doesNotThrow(() => validateTransferStart({ ...ok, transferId: id }, DST));
    }
});

// Each path becomes a stat round trip on a foreign connection — cap how many one message can buy.
test("too many paths are refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, paths: new Array(257).fill("/a") }, DST), /invalid/i);
});

test("a non-string or overlong path is refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, paths: [7] }, DST), /invalid/i);
    assert.throws(() => validateTransferStart({ ...ok, paths: ["x".repeat(4097)] }, DST), /invalid/i);
});

test("an empty path within paths is refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, paths: [""] }, DST), /invalid/i);
});

test("a non-array paths value is refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, paths: "/a" }, DST), /invalid/i);
});

test("an empty sourceSessionId is refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, sourceSessionId: "" }, DST), /invalid/i);
});

test("an empty destination is refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, destination: "" }, DST), /invalid/i);
});

test("a destination longer than the path length limit is refused", () => {
    assert.throws(() => validateTransferStart({ ...ok, destination: "/" + "x".repeat(4096) }, DST), /invalid/i);
});

// The four passed-through fields feed the register key, the auxiliary connections and the run
// itself in the next task — a swap here would not crash, it would move the wrong files.
test("transferId, source, destination and paths pass through unchanged and unswapped", () => {
    const payload = { transferId: "tx-1", sourceSessionId: "sess-2", paths: ["/path-3", "/path-4"],
        destination: "/dest-5", action: "copy" };
    const result = validateTransferStart(payload, "unrelated-dst");
    assert.strictEqual(result.transferId, "tx-1");
    assert.deepStrictEqual(result.source, { kind: "sftp", sessionId: "sess-2" });
    assert.strictEqual(result.destination, "/dest-5");
    assert.deepStrictEqual(result.paths, ["/path-3", "/path-4"]);
});

const base = { transferId: "t1", destination: "/ziel", paths: ["/a.txt"] };
const destination = { kind: "sftp", sessionId: "dest" };

// The deployed client sends sourceSessionId. Breaking it would break the running installation.
test("a legacy sourceSessionId is read as an sftp endpoint", () => {
    const request = validateTransferStart({ ...base, sourceSessionId: "src" }, destination);

    assert.deepStrictEqual(request.source, { kind: "sftp", sessionId: "src" });
});

test("an explicit endpoint is used as given", () => {
    const request = validateTransferStart({ ...base, source: { kind: "onedrive", connectionId: 7 } }, destination);

    assert.deepStrictEqual(request.source, { kind: "onedrive", connectionId: 7, driveId: "me" });
});

// Two fields meaning the same thing is a caller that does not know what it wants.
test("both forms at once are refused", () => {
    assert.throws(() => validateTransferStart(
        { ...base, sourceSessionId: "src", source: { kind: "sftp", sessionId: "src" } }, destination), /Invalid/);
});

test("neither form is refused", () => {
    assert.throws(() => validateTransferStart(base, destination), /Invalid/);
});

// Source and destination on one session resolve to the same auxiliary client, which deadlocks.
test("an sftp source equal to the destination session is refused", () => {
    assert.throws(() => validateTransferStart({ ...base, sourceSessionId: "dest" }, destination), /Invalid/);
});

// Two OneDrive sides are fine — they are two independent HTTP clients, not one connection.
test("a onedrive source against a onedrive destination is allowed", () => {
    const request = validateTransferStart({ ...base, source: { kind: "onedrive", connectionId: 7 } },
        { kind: "onedrive", connectionId: 9, driveId: "me" });

    assert.strictEqual(request.source.connectionId, 7);
});

// The same drive on both sides would have the transfer read and write the same items.
test("the same onedrive connection on both sides is refused", () => {
    assert.throws(() => validateTransferStart({ ...base, source: { kind: "onedrive", connectionId: 7 } },
        { kind: "onedrive", connectionId: 7, driveId: "me" }), /Invalid/);
});

test("a malformed endpoint is refused by the same validation as everywhere else", () => {
    assert.throws(() => validateTransferStart({ ...base, source: { kind: "ftp" } }, destination), /Invalid/);
});

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
    assert.throws(() => validateTransferStart({ ...ok, sourceSessionId: DST }, DST), /invalid/i);
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

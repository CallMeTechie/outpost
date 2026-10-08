const test = require("node:test");
const assert = require("node:assert");
const { encodeFrame, nextSeq, OPCODE_FRAME } = require("../frameProtocol");

test("a frame carries the opcode and a big-endian sequence, and the sequence wraps at 2^32", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const frame = encodeFrame(0xffffffff, jpeg);
    assert.deepStrictEqual([...frame.subarray(0, 5)], [OPCODE_FRAME, 0xff, 0xff, 0xff, 0xff]);
    assert.deepStrictEqual(frame.subarray(5), jpeg);
    assert.strictEqual(nextSeq(0xffffffff), 0);
});

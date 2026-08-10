const test = require("node:test");
const assert = require("node:assert");
const { OP } = require("../../routes/sftpWS");

const TRANSFER_OPS = ["TRANSFER_START", "TRANSFER_PROGRESS", "TRANSFER_DONE", "TRANSFER_ERROR",
    "TRANSFER_CANCEL", "TRANSFER_CONFLICT", "TRANSFER_RESOLVE"];

test("every transfer opcode exists", () => {
    for (const name of TRANSFER_OPS) {
        assert.strictEqual(typeof OP[name], "number", `${name} is missing`);
    }
});

test("no opcode value is used twice", () => {
    const values = Object.values(OP);
    assert.strictEqual(new Set(values).size, values.length);
});

test("transfer opcodes sit above the pre-existing range", () => {
    for (const name of TRANSFER_OPS) assert.ok(OP[name] > 0x12, `${name} collides with an existing opcode`);
});

test("every opcode fits in one byte", () => {
    for (const [name, value] of Object.entries(OP)) {
        assert.ok(Number.isInteger(value) && value >= 0 && value <= 255, `${name} is not a byte`);
    }
});

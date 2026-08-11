import test from "node:test";
import assert from "node:assert";
import { OPERATIONS } from "../operations.js";

const TRANSFER_OPS = {
    TRANSFER_START: 0x13, TRANSFER_PROGRESS: 0x14, TRANSFER_DONE: 0x15, TRANSFER_ERROR: 0x16,
    TRANSFER_CANCEL: 0x17, TRANSFER_CONFLICT: 0x18, TRANSFER_RESOLVE: 0x19,
};

test("every transfer opcode carries the value the server expects", () => {
    for (const [name, value] of Object.entries(TRANSFER_OPS)) {
        assert.strictEqual(OPERATIONS[name], value, `${name} does not match the server`);
    }
});

test("PATH_SYNC is present, the drift this table had before", () => {
    assert.strictEqual(OPERATIONS.PATH_SYNC, 0x12);
});

test("no opcode value is used twice", () => {
    const values = Object.values(OPERATIONS);
    assert.strictEqual(new Set(values).size, values.length);
});

test("every opcode fits in one byte", () => {
    for (const [name, value] of Object.entries(OPERATIONS)) {
        assert.ok(Number.isInteger(value) && value >= 0 && value <= 255, `${name} is not a byte`);
    }
});

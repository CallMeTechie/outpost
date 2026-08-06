const test = require("node:test");
const assert = require("node:assert");
const { createServerValidation } = require("../../validations/server");

const build = (config) => ({ name: "host", config: { protocol: "ssh", ip: "10.0.0.1", ...config } });

test("initialCommand: accepts a plain command", () => {
    const { error } = createServerValidation.validate(build({ initialCommand: "docker compose up -d" }));
    assert.strictEqual(error, undefined);
});

test("initialCommand: accepts an empty string", () => {
    const { error } = createServerValidation.validate(build({ initialCommand: "" }));
    assert.strictEqual(error, undefined);
});

test("initialCommand: rejects a newline", () => {
    const { error } = createServerValidation.validate(build({ initialCommand: "echo a\necho b" }));
    assert.ok(error, "expected a validation error");
});

test("initialCommand: rejects a carriage return", () => {
    const { error } = createServerValidation.validate(build({ initialCommand: "echo a\recho b" }));
    assert.ok(error, "expected a validation error");
});

test("initialCommand: rejects more than 512 characters", () => {
    const { error } = createServerValidation.validate(build({ initialCommand: "x".repeat(513) }));
    assert.ok(error, "expected a validation error");
});

test("initialCommand: accepts exactly 512 characters", () => {
    const { error } = createServerValidation.validate(build({ initialCommand: "x".repeat(512) }));
    assert.strictEqual(error, undefined);
});

test("tmuxEnabled: accepts a boolean", () => {
    const { error } = createServerValidation.validate(build({ tmuxEnabled: true }));
    assert.strictEqual(error, undefined);
});

test("tmuxEnabled: rejects a string", () => {
    const { error } = createServerValidation.validate(build({ tmuxEnabled: "yes" }));
    assert.ok(error, "expected a validation error");
});

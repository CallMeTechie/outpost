const test = require("node:test");
const assert = require("node:assert");
const { createServerValidation } = require("../../validations/server");
const { createSessionValidation } = require("../../validations/serverSession");

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

const session = (extra) => ({ entryId: 1, ...extra });

test("tmuxSession: accepts a permissive name when attaching", () => {
    assert.strictEqual(createSessionValidation.validate(session({ tmuxSession: "mein projekt" })).error, undefined);
    assert.strictEqual(createSessionValidation.validate(session({ tmuxSession: "build|test" })).error, undefined);
    assert.strictEqual(createSessionValidation.validate(session({ tmuxSession: "web.dev" })).error, undefined);
});

test("tmuxSession: rejects control characters", () => {
    assert.ok(createSessionValidation.validate(session({ tmuxSession: "a\nb" })).error);
    assert.ok(createSessionValidation.validate(session({ tmuxSession: "a\x00b" })).error);
});

test("tmuxSession: rejects more than 128 characters", () => {
    assert.ok(createSessionValidation.validate(session({ tmuxSession: "x".repeat(129) })).error);
});

test("tmuxSession: null and absence stay valid", () => {
    assert.strictEqual(createSessionValidation.validate(session({ tmuxSession: null })).error, undefined);
    assert.strictEqual(createSessionValidation.validate(session({})).error, undefined);
});

test("tmuxCreate: enforces the strict name rule", () => {
    assert.strictEqual(createSessionValidation.validate(session({ tmuxSession: "work-1", tmuxCreate: true })).error, undefined);
    assert.ok(createSessionValidation.validate(session({ tmuxSession: "web.dev", tmuxCreate: true })).error);
    assert.ok(createSessionValidation.validate(session({ tmuxSession: "a:b", tmuxCreate: true })).error);
    assert.ok(createSessionValidation.validate(session({ tmuxSession: "mein projekt", tmuxCreate: true })).error);
});

test("tmuxCreate: requires a session name", () => {
    assert.ok(createSessionValidation.validate(session({ tmuxCreate: true })).error);
});

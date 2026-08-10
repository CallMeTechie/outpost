const test = require("node:test");
const assert = require("node:assert");
const { getCapabilities, CHECKSUM_COMMANDS, escapePath } = require("../fileCapabilities");

// Note: sftp has a shell but no terminal — TERMINAL_LESS_PROTOCOLS contains "sftp".
test("sftp entries have a shell but no terminal", () => {
    const caps = getCapabilities({ type: "server", config: { protocol: "sftp" } });
    assert.deepStrictEqual(caps, { shell: true, terminal: false });
});

test("ssh entries have both", () => {
    const caps = getCapabilities({ type: "server", config: { protocol: "ssh" } });
    assert.deepStrictEqual(caps, { shell: true, terminal: true });
});

test("ftp entries have neither", () => {
    assert.deepStrictEqual(getCapabilities({ type: "server", config: { protocol: "ftp" } }),
        { shell: false, terminal: false });
});

test("ftps entries have no shell", () => {
    assert.strictEqual(getCapabilities({ type: "server", config: { protocol: "ftps" } }).shell, false);
});

test("non-server entries fall back to the entry type", () => {
    assert.strictEqual(getCapabilities({ type: "sftp" }).shell, true);
});

test("checksum commands cover the four algorithms", () => {
    assert.strictEqual(CHECKSUM_COMMANDS.sha256, "sha256sum");
    assert.strictEqual(Object.keys(CHECKSUM_COMMANDS).length, 4);
});

test("checksum commands have no prototype properties", () => {
    assert.strictEqual(CHECKSUM_COMMANDS.constructor, undefined);
});

test("escapePath neutralises command substitution and traversal", () => {
    assert.strictEqual(escapePath("../$(id)`id`"), "'../$(id)`id`'");
    assert.strictEqual(escapePath("a'b"), "'a'\\''b'");
});

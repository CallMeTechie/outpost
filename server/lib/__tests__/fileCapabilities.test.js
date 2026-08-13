const test = require("node:test");
const assert = require("node:assert");
const { getCapabilities, CHECKSUM_COMMANDS, escapePath } = require("../fileCapabilities");
const { ONEDRIVE_CAPABILITIES } = require("../../routes/oneDriveWS");

// Note: sftp has a shell but no terminal — TERMINAL_LESS_PROTOCOLS contains "sftp".
test("sftp entries have a shell but no terminal", () => {
    const caps = getCapabilities({ type: "server", config: { protocol: "sftp" } });
    assert.deepStrictEqual(caps, { shell: true, terminal: false, copy: true });
});

test("ssh entries have both", () => {
    const caps = getCapabilities({ type: "server", config: { protocol: "ssh" } });
    assert.deepStrictEqual(caps, { shell: true, terminal: true, copy: true });
});

test("ftp entries have neither", () => {
    assert.deepStrictEqual(getCapabilities({ type: "server", config: { protocol: "ftp" } }),
        { shell: false, terminal: false, copy: false });
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

const server = (protocol) => ({ type: "server", config: { protocol } });

test("copy follows shell for every protocol that exists today", () => {
    for (const protocol of ["ssh", "sftp", "ftp", "ftps"]) {
        const caps = getCapabilities(server(protocol));
        assert.strictEqual(caps.copy, caps.shell, protocol);
    }
});

test("ssh keeps all three, ftp keeps none of the two that need a shell", () => {
    assert.deepStrictEqual(getCapabilities(server("ssh")), { shell: true, terminal: true, copy: true });
    assert.deepStrictEqual(getCapabilities(server("ftp")), { shell: false, terminal: false, copy: false });
    assert.deepStrictEqual(getCapabilities(server("sftp")), { shell: true, terminal: false, copy: true });
});

// The OneDrive socket used to answer with a word nobody reads (`checksum`) and to omit one the
// client does read (`terminal`). Pinning the key SET rather than the values is what stops that
// from happening again the next time a word is added.
test("the OneDrive socket answers in the same vocabulary the rest of the app speaks", () => {
    assert.deepStrictEqual(
        Object.keys(ONEDRIVE_CAPABILITIES).sort(),
        Object.keys(getCapabilities(server("ssh"))).sort(),
    );
});

test("OneDrive has no shell and no terminal, but can copy", () => {
    assert.deepStrictEqual(ONEDRIVE_CAPABILITIES, { shell: false, terminal: false, copy: true });
});

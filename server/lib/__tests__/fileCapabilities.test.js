const test = require("node:test");
const assert = require("node:assert");
const { getCapabilities, CHECKSUM_COMMANDS, escapePath } = require("../fileCapabilities");
const { ONEDRIVE_CAPABILITIES } = require("../../routes/oneDriveWS");

// Note: sftp has a shell but no terminal — TERMINAL_LESS_PROTOCOLS contains "sftp".
test("sftp entries have a shell but no terminal", () => {
    const caps = getCapabilities({ type: "server", config: { protocol: "sftp" } });
    assert.deepStrictEqual(caps, { shell: true, terminal: false, copy: true, nativeFs: true, content: true });
});

test("ssh entries have both", () => {
    const caps = getCapabilities({ type: "server", config: { protocol: "ssh" } });
    assert.deepStrictEqual(caps, { shell: true, terminal: true, copy: true, nativeFs: true, content: true });
});

test("ftp entries have neither", () => {
    assert.deepStrictEqual(getCapabilities({ type: "server", config: { protocol: "ftp" } }),
        { shell: false, terminal: false, copy: false, nativeFs: true, content: true });
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

// The word this replaces was `shell`, which is false for ftp and ftps — two protocols on the same
// engine client, in production, that do have empty files, directory completion, symbolic links and
// permissions. Pinned per protocol so that "is this OneDrive?" cannot be smuggled onto it again.
test("every server protocol that exists today has a native file system behind it", () => {
    for (const protocol of ["ssh", "sftp", "ftp", "ftps"]) {
        assert.strictEqual(getCapabilities(server(protocol)).nativeFs, true, protocol);
    }
    assert.strictEqual(ONEDRIVE_CAPABILITIES.nativeFs, false);
});

// Download, upload, preview and the editor all go through routes keyed by an SFTP session — and,
// since routes/oneDriveContent.js added the same three routes keyed by a connection id instead, a
// OneDrive drive too. The worst of the old gap submitted a form into the main window and navigated
// the whole application onto a 404 when a OneDrive pane answered it; content: true is what un-hides
// those controls now that the routes exist.
test("every provider, server and drive alike, can serve file content", () => {
    for (const protocol of ["ssh", "sftp", "ftp", "ftps"]) {
        assert.strictEqual(getCapabilities(server(protocol)).content, true, protocol);
    }
    assert.strictEqual(ONEDRIVE_CAPABILITIES.content, true);
});

// The pane falls back to this before READY arrives. A fallback that misses the newest word inverts
// its meaning, which is the exact failure the words themselves are meant to prevent.
test("the pane's fallback speaks the same vocabulary and grants everything", async () => {
    const { DEFAULT_CAPABILITIES } = await import(
        "../../../client/src/pages/Servers/components/ViewContainer/renderer/FileRenderer/utils/paneCapabilities.js");

    assert.deepStrictEqual(Object.keys(DEFAULT_CAPABILITIES).sort(), Object.keys(getCapabilities(server("ssh"))).sort());
    assert.ok(Object.values(DEFAULT_CAPABILITIES).every((value) => value === true));
});

test("ssh keeps all three, ftp keeps none of the two that need a shell", () => {
    assert.deepStrictEqual(getCapabilities(server("ssh")), { shell: true, terminal: true, copy: true, nativeFs: true, content: true });
    assert.deepStrictEqual(getCapabilities(server("ftp")), { shell: false, terminal: false, copy: false, nativeFs: true, content: true });
    assert.deepStrictEqual(getCapabilities(server("sftp")), { shell: true, terminal: false, copy: true, nativeFs: true, content: true });
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

test("OneDrive has no shell, no terminal and no native file system, but can copy and serve content", () => {
    assert.deepStrictEqual(ONEDRIVE_CAPABILITIES, { shell: false, terminal: false, copy: true, nativeFs: false, content: true });
});

const test = require("node:test");
const assert = require("node:assert");
const { buildManifest } = require("../build-updater-manifest.js");

const SIGNATURES = {
    "windows-x86_64": "sig-win-x64",
    "windows-aarch64": "sig-win-arm64",
    "darwin-x86_64": "sig-mac-x64",
    "darwin-aarch64": "sig-mac-arm64",
    "linux-x86_64": "sig-linux-x64",
};

const INPUT = {
    version: "0.1.1",
    notes: "Outpost Connector 0.1.1",
    pubDate: "2026-08-20T10:00:00Z",
    baseUrl: "https://github.com/CallMeTechie/outpost/releases/download/v0.1.1",
    signatures: SIGNATURES,
};

test("every platform carries its signature and a download url", () => {
    const m = buildManifest(INPUT);

    assert.strictEqual(m.version, "0.1.1");
    assert.deepStrictEqual(Object.keys(m.platforms).sort(), Object.keys(SIGNATURES).sort());
    assert.strictEqual(m.platforms["linux-x86_64"].signature, "sig-linux-x64");
    assert.strictEqual(
        m.platforms["linux-x86_64"].url,
        "https://github.com/CallMeTechie/outpost/releases/download/v0.1.1/outpost-connector-linux-x64.AppImage",
    );
});

test("windows points at the NSIS installer, never the msi", () => {
    const m = buildManifest(INPUT);

    assert.match(m.platforms["windows-x86_64"].url, /outpost-connector-windows-x64\.exe$/);
    assert.doesNotMatch(m.platforms["windows-x86_64"].url, /\.msi$/);
});

test("macos points at the app bundle archive, never the dmg", () => {
    const m = buildManifest(INPUT);

    assert.match(m.platforms["darwin-aarch64"].url, /outpost-connector-macos-arm64\.app\.tar\.gz$/);
    assert.doesNotMatch(m.platforms["darwin-aarch64"].url, /\.dmg$/);
});

test("a missing signature fails loudly instead of shipping a partial manifest", () => {
    const incomplete = { ...INPUT, signatures: { ...SIGNATURES } };
    delete incomplete.signatures["darwin-x86_64"];

    assert.throws(() => buildManifest(incomplete), /darwin-x86_64/);
});

test("an empty signature counts as missing", () => {
    const blank = { ...INPUT, signatures: { ...SIGNATURES, "linux-x86_64": "  " } };

    assert.throws(() => buildManifest(blank), /linux-x86_64/);
});

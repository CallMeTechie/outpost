const test = require("node:test");
const assert = require("node:assert");
const { buildManifest, ASSETS } = require("../build-updater-manifest.js");

const SIGNATURES = {
    "windows-x86_64": "sig-win-x64",
    "windows-x86_64-msi": "sig-win-x64-msi",
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

test("every platform url points at its own asset from ASSETS", () => {
    const m = buildManifest(INPUT);

    for (const [key, asset] of Object.entries(ASSETS)) {
        assert.strictEqual(m.platforms[key].url, `${INPUT.baseUrl}/${asset}`);
    }
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

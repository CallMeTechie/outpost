const fs = require("node:fs");

// The updater manifest maps Tauri's OS-ARCH(-installer) platform keys to the
// release assets it may install. Tauri looks up `{os}-{arch}-{installer}`
// before falling back to `{os}-{arch}`, so the MSI build gets its own
// "windows-x86_64-msi" key and the plain "windows-x86_64" entry stays the
// NSIS fallback for anything that doesn't report itself as an MSI install.
// deb and rpm are still absent: the updater cannot replace those formats in
// place, that's the package manager's job.
//
// These names are also the filenames the workflow must hand over in the
// signature directory. Tauri's own bundle filenames derive from productName
// ("Outpost Connector") and differ; the workflow renames them first.
const ASSETS = {
    "windows-x86_64": "outpost-connector-windows-x64.exe",
    "windows-x86_64-msi": "outpost-connector-windows-x64.msi",
    "windows-aarch64": "outpost-connector-windows-arm64.exe",
    "darwin-x86_64": "outpost-connector-macos-x64.app.tar.gz",
    "darwin-aarch64": "outpost-connector-macos-arm64.app.tar.gz",
    "linux-x86_64": "outpost-connector-linux-x64.AppImage",
};

const PLATFORM_KEYS = Object.keys(ASSETS);

const buildManifest = ({ version, notes, pubDate, baseUrl, signatures }) => {
    const platforms = {};

    for (const key of PLATFORM_KEYS) {
        const signature = signatures ? signatures[key] : undefined;
        if (typeof signature !== "string" || signature.trim() === "") {
            // A manifest missing one platform looks valid and silently strands
            // that platform on its current version forever. Refuse instead.
            throw new Error(`missing signature for ${key}`);
        }
        platforms[key] = { signature: signature.trim(), url: `${baseUrl}/${ASSETS[key]}` };
    }

    return { version, notes, pub_date: pubDate, platforms };
};

const main = () => {
    const [version, sigDir, outFile] = process.argv.slice(2);

    if (!version || !sigDir || !outFile) {
        console.error("usage: build-updater-manifest.js <version> <signature-dir> <out-file>");
        process.exit(1);
    }

    const signatures = {};
    for (const [key, asset] of Object.entries(ASSETS)) {
        const path = `${sigDir}/${asset}.sig`;
        // Read the signature verbatim. Tauri already stores base64 in the .sig
        // file and the manifest wants exactly that content — encoding it again
        // here would break every update.
        signatures[key] = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
    }

    const manifest = buildManifest({
        version,
        notes: `Outpost Connector ${version} — https://github.com/CallMeTechie/outpost/releases/tag/v${version}`,
        pubDate: new Date().toISOString(),
        baseUrl: `https://github.com/CallMeTechie/outpost/releases/download/v${version}`,
        signatures,
    });

    fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${outFile} for ${PLATFORM_KEYS.length} platforms`);
};

if (require.main === module) {
    main();
}

module.exports = { buildManifest, PLATFORM_KEYS, ASSETS };

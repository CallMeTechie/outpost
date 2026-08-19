import { isTauri } from "@/common/utils/TauriUtil.js";

export { canSelfUpdate, packageHintKey } from "@/common/utils/updaterPolicy.js";

export const getInstallationKind = async () => {
    if (!isTauri()) return null;

    try {
        const { invoke } = await import("@tauri-apps/api/core");
        return await invoke("installation_kind");
    } catch (e) {
        console.warn("Failed to read installation kind:", e);
        return null;
    }
};

export const checkForUpdate = async () => {
    if (!isTauri()) return null;

    try {
        const { check } = await import("@tauri-apps/plugin-updater");
        // Called with no arguments deliberately: the JS API accepts a per-call
        // `endpoints` override, and this app must only ever read the endpoint
        // baked into tauri.conf.json at build time. Do not add an options
        // object here without re-reviewing that constraint.
        return await check();
    } catch (e) {
        // No network, unreachable endpoint, unparsable manifest. Staying
        // silent is deliberate: a start-up error about the updater itself is
        // worse than not updating.
        console.warn("Update check failed:", e);
        return null;
    }
};

export const installUpdate = async (update, onProgress) => {
    let downloaded = 0;
    let total = 0;

    await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
            total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
            downloaded += event.data.chunkLength;
            onProgress?.(total ? downloaded / total : 0);
        } else if (event.event === "Finished") {
            onProgress?.(1);
        }
    });

    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
};

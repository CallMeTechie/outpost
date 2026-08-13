// The walk that turns a selection into a ZIP. It reads through the eight-method seam, which is
// what lets one implementation serve both a server and a OneDrive account — the sftp client and
// the Graph adapter answer listDir, stat and readFile alike.
const logger = require("../../utils/logger");

const getFileName = (p) => p.split("/").pop();

const appendFile = async (adapter, archive, path, name) => {
    const { stream, totalSizePromise, done } = adapter.readFile(path);
    stream.on("error", (err) => logger.warn("Archive stream error", { error: err.message, path }));
    // The engine reports the size out of band and the archive wants it before the bytes; the
    // Graph adapter has no such step, because its request is over before a byte flows.
    if (totalSizePromise) await totalSizePromise;
    archive.append(stream, { name });
    await done;
};

const archiveFolder = async (adapter, archive, dirPath, basePath) => {
    const entries = await adapter.listDir(dirPath);
    if (entries.length === 0) {
        archive.append("", { name: basePath + "/" });
        return;
    }
    for (const entry of entries) {
        if (entry.isSymlink) continue;
        const fullPath = dirPath === "/" ? `/${entry.name}` : `${dirPath}/${entry.name}`;
        const archivePath = basePath ? `${basePath}/${entry.name}` : entry.name;
        if (entry.type === "folder") await archiveFolder(adapter, archive, fullPath, archivePath);
        else await appendFile(adapter, archive, fullPath, archivePath);
    }
};

const archiveItems = async (adapter, archive, paths) => {
    for (const path of paths) {
        try {
            const stats = await adapter.stat(path);
            const name = getFileName(path);
            if (stats.type === "folder") await archiveFolder(adapter, archive, path, name);
            else await appendFile(adapter, archive, path, name);
        } catch (err) {
            logger.warn("Failed to add file to archive", { path, error: err.message });
        }
    }
};

module.exports = { archiveFolder, archiveItems };

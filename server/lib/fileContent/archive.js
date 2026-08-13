// The walk that turns a selection into a ZIP. It reads through the eight-method seam, which is
// what lets one implementation serve both a server and a OneDrive account — the sftp client and
// the Graph adapter answer listDir, stat and readFile alike.
const logger = require("../../utils/logger");

const getFileName = (p) => p.split("/").pop();

// A stream failure that surfaces after archive.append() has already run is not the same problem
// as a path that could never be opened: bytes may already be queued into the archive, so the
// archive is no longer salvageable and the caller must find out, not move on to the next path.
class ArchiveStreamError extends Error {}

const appendFile = async (adapter, archive, path, name) => {
    const { stream, totalSizePromise, done } = adapter.readFile(path);
    stream.on("error", (err) => logger.warn("Archive stream error", { error: err.message, path }));
    // The engine reports the size out of band and the archive wants it before the bytes; the
    // Graph adapter has no such step, because its request is over before a byte flows. A missing
    // field resolves to undefined, and awaiting undefined is already a no-op — no branch needed.
    await totalSizePromise;
    archive.append(stream, { name });
    try {
        await done;
    } catch (err) {
        throw new ArchiveStreamError(err.message, { cause: err });
    }
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
            // A mid-stream failure has already put bytes in the archive; swallowing it here would
            // leave archiver waiting on a stream that will never finish, so it must keep going up.
            if (err instanceof ArchiveStreamError) throw err;
            logger.warn("Failed to add file to archive", { path, error: err.message });
        }
    }
};

module.exports = { archiveFolder, archiveItems };

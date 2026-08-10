// 64 matches the engine's own recursion limit for rmdir; deeper trees could not be cleaned up
// on the other side anyway.
const MAX_WALK_DEPTH = 64;
const MAX_WALK_ENTRIES = 200000;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

// Names come from the SOURCE SERVER and are not trustworthy: the engine only filters the exact
// entries "." and "..", and over FTP the name is the unchecked remainder of the LIST line.
// Without this check join(destination, relPath) writes outside the destination directory.
// Same rule as the existing one in server/routes/sftp.js:120.
const UNSAFE_NAME = /[/\\\x00-\x1f]/;

const basename = (path) => path.replace(/\/+$/, "").split("/").pop();
const join = (parent, rel) => {
    if (rel.startsWith("/") || rel.split("/").includes("..")) throw new Error("Unsafe destination path");
    return parent.endsWith("/") ? `${parent}${rel}` : `${parent}/${rel}`;
};

const assertSafeName = (name) => {
    if (typeof name !== "string" || name === "" || name === "." || name === ".." || UNSAFE_NAME.test(name)) {
        throw new Error(`Unsafe file name from the source server: ${JSON.stringify(name)}`);
    }
    return name;
};

const isLink = (entry) => Boolean(entry.isSymlink) || ((entry.mode & S_IFMT) === S_IFLNK);

const walk = async (source, paths, { isCancelled = () => false } = {}) => {
    const files = [];
    const dirs = [];
    const skipped = [];
    const topLevelFolders = [];

    const guard = (depth) => {
        if (isCancelled()) throw new Error("Transfer cancelled");
        if (depth > MAX_WALK_DEPTH) throw new Error("Source tree is too deep");
        if (files.length + dirs.length + skipped.length > MAX_WALK_ENTRIES) {
            throw new Error("Source tree has too many entries");
        }
    };

    const walkDir = async (srcDir, relDir, depth) => {
        guard(depth);
        dirs.push({ srcPath: srcDir, relPath: relDir });
        for (const entry of await source.listDir(srcDir)) {
            const name = assertSafeName(entry.name);
            const srcPath = `${srcDir.endsWith("/") ? srcDir : `${srcDir}/`}${name}`;
            const relPath = `${relDir}/${name}`;
            if (isLink(entry)) {
                skipped.push({ path: srcPath, relPath, reason: "symlink" });
            } else if (entry.type === "folder") {
                await walkDir(srcPath, relPath, depth + 1);
            } else {
                files.push({ srcPath, relPath, size: entry.size, mtime: entry.mtime });
            }
        }
    };

    for (const path of paths) {
        const name = assertSafeName(basename(path));
        const info = await source.stat(path).catch(() => null);
        if (!info) throw new Error(`Source path no longer exists: ${path}`);
        if (info.type === "folder") {
            topLevelFolders.push(path);
            await walkDir(path, name, 0);
        } else {
            files.push({ srcPath: path, relPath: name, size: info.size, mtime: info.mtime });
        }
    }

    // Two paths with the same basename would map onto one destination file; on a move both
    // sources would be deleted while only one survives at the destination.
    const seen = new Set();
    for (const rel of [...dirs.map((d) => d.relPath), ...files.map((f) => f.relPath)]) {
        if (seen.has(rel)) throw new Error(`Ambiguous transfer target: ${rel}`);
        seen.add(rel);
    }

    return { files, dirs, skipped, topLevelFolders, totalBytes: files.reduce((sum, f) => sum + f.size, 0) };
};

module.exports = { walk, join, basename };

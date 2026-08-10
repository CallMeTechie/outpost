const { walk, join } = require("./walk");

// Upper bound for the buffer of one in-flight file. readFile has no backpressure (the engine keeps
// pushing even when the PassThrough is full), so the transfer aborts in a controlled way instead
// of letting the process grow without bound.
const MAX_BUFFER = 32 * 1024 * 1024;

// No data frame within this window counts as a stalled read. readFile has no timeout of its own —
// REQUEST_TIMEOUT and WRITE_END_TIMEOUT do not apply there.
const READ_STALL_TIMEOUT = 60_000;

// How much a file may grow between the walk and the read. Without a cap a source that reports
// size 0 and delivers forever (/dev/zero, /proc, a lying server) fills the destination disk —
// MAX_BUFFER does not catch it, because the buffer never builds up.
const MAX_SIZE_OVERRUN = 16 * 1024 * 1024;

const WATCHDOG_INTERVAL = 500;

const NOT_FOUND = /no such file|no such path|not found|does not exist|ENOENT/i;
const isNotFound = (err) => err?.code === "ENOENT" || NOT_FOUND.test(String(err?.message || ""));

class FileTransfer {
    constructor({ source, dest, destCleanup, onProgress, onConflict }) {
        this.source = source;
        this.dest = dest;
        this.destCleanup = destCleanup || dest;
        this.onProgress = onProgress || (() => {});
        this.onConflict = onConflict || (async () => "overwrite");

        this.action = "copy";
        this.conflictMode = "ask";
        this.bytesTotal = 0;
        this.filesTotal = 0;
        this.bytesDone = 0;
        this.filesDone = 0;
        this.filesSkipped = 0;
        this.sourceIncomplete = false;
        this.leftovers = [];
        this._createdDirs = new Set();
    }

    async run(paths, destination, { action = "copy", onConflict = "ask" } = {}) {
        this.action = action;
        this.conflictMode = onConflict;

        try {
            return await this._run(paths, destination);
        } catch (err) {
            if (this.leftovers.length > 0) err.leftovers = this.leftovers;
            throw err;
        }
    }

    async _run(paths, destination) {
        const plan = await walk(this.source, paths);
        this.bytesTotal = plan.totalBytes;
        this.filesTotal = plan.files.length;
        this.filesSkipped = plan.skipped.length;

        for (const dir of plan.dirs) {
            await this._ensureDir(join(destination, dir.relPath));
        }

        for (const file of plan.files) {
            const destPath = join(destination, file.relPath);

            const decision = await this._resolveConflict(file, destPath);
            if (decision === "abort") return this._result(true);
            if (decision === "skip") {
                // Take skipped files out of the totals, otherwise the progress bar stops short
                // even though the transfer succeeded.
                this.filesSkipped += 1;
                this.bytesTotal -= file.size;
                this.filesTotal -= 1;
                this._report(file.relPath);
                continue;
            }

            await this._copyFile(file, destPath);
        }

        return this._result(false);
    }

    _result(cancelled) {
        return {
            filesTransferred: this.filesDone,
            filesSkipped: this.filesSkipped,
            cancelled,
            leftovers: this.leftovers,
        };
    }

    // mkdirRecursive costs one stat per path segment, so remember what already exists.
    async _ensureDir(path) {
        if (this._createdDirs.has(path)) return;

        // The spec makes a file/folder type conflict an error with the path, independent of
        // onConflict. mkdirRecursive would only pass the raw engine text through.
        const existing = await this.dest.stat(path).catch(() => null);
        if (existing && existing.type !== "folder") {
            throw new Error(`Target already exists with a different type: ${path}`);
        }

        await this.dest.mkdirRecursive(path);
        for (let p = path; p && p !== "/"; p = p.slice(0, p.lastIndexOf("/"))) this._createdDirs.add(p);
    }

    async _copyFile(file, destPath) {
        try {
            const { stream, done } = this.source.readFile(file.srcPath);

            stream.on("data", (chunk) => {
                this.bytesDone += chunk.length;
                this._report(file.relPath);
            });

            await this.dest.writeFile(destPath, stream);
            await done;
        } catch (err) {
            await this._removePartial(destPath);
            if (isNotFound(err)) {
                // The spec wants a source file that vanished between walk and read counted as
                // skipped. A move must not delete anything after this.
                this.filesSkipped += 1;
                this.sourceIncomplete = true;
                this._report(file.relPath);
                return false;
            }
            throw err;
        }

        this.filesDone += 1;
        this._report(file.relPath);
        return true;
    }

    async _resolveConflict(file, destPath) {
        let existing = null;
        try {
            existing = await this.dest.stat(destPath);
        } catch (err) {
            // Only "does not exist" may mean free rein. A permission, IO or timeout error would
            // otherwise overwrite exactly the file that onConflict: "skip" was meant to protect.
            if (!isNotFound(err)) throw new Error(`Cannot inspect target ${destPath}: ${err.message}`, { cause: err });
        }
        if (!existing) return "overwrite";

        if (existing.type !== "file") {
            throw new Error(`Target already exists with a different type: ${destPath}`);
        }

        if (this.conflictMode === "overwrite") return "overwrite";
        if (this.conflictMode === "skip") return "skip";

        return this.onConflict({
            file: file.relPath,
            destSize: existing.size,
            destMtime: existing.mtime,
            destType: existing.type,
            srcSize: file.size,
            srcMtime: file.mtime,
            srcType: "file",
        });
    }

    async _removePartial(destPath) {
        try {
            await this.destCleanup.unlink(destPath);
        } catch {
            // Best effort — but the path of a leftover partial file must stay reportable, and the
            // original error must not be masked.
            this.leftovers.push(destPath);
        }
    }

    _report(file) {
        this.onProgress({
            file,
            bytesDone: this.bytesDone,
            bytesTotal: this.bytesTotal,
            filesDone: this.filesDone,
            filesTotal: this.filesTotal,
        });
    }
}

module.exports = { FileTransfer, MAX_BUFFER, READ_STALL_TIMEOUT, WATCHDOG_INTERVAL, MAX_SIZE_OVERRUN };

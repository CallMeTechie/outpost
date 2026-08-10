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

        await this._ensureDirs(destination, plan.dirs);

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

    // mkdirRecursive creates every parent segment of the path it is given, so a directory that
    // is itself the ancestor of another directory in this same plan needs no explicit call —
    // it comes into existence as a side effect of creating its descendant. Skipping it saves a
    // full stat-per-segment round trip for every level a deep tree shares between branches.
    // The type-conflict check still runs for every directory in the plan, independent of
    // whether mkdirRecursive is called for it: a file blocking a directory must be caught even
    // when the directory itself would only ever be created implicitly.
    async _ensureDirs(destination, dirs) {
        const dirPaths = dirs.map((dir) => join(destination, dir.relPath));

        for (const path of dirPaths) {
            // The spec makes a file/folder type conflict an error with the path, independent of
            // onConflict. mkdirRecursive would only pass the raw engine text through.
            const existing = await this.dest.stat(path).catch(() => null);
            if (existing && existing.type !== "folder") {
                throw new Error(`Target already exists with a different type: ${path}`);
            }

            const hasDescendant = dirPaths.some((other) => other !== path && other.startsWith(`${path}/`));
            if (!hasDescendant) await this.dest.mkdirRecursive(path);
        }
    }

    async _copyFile(file, destPath) {
        // Only a write attempt that actually reached the destination can have left a partial
        // file behind. readFile() can fail before that point (e.g. the source vanished) — in
        // that case there is nothing at destPath to clean up, and reporting it as a leftover
        // would be a false claim to the user.
        let writeAttempted = false;
        try {
            const { stream, done } = this.source.readFile(file.srcPath);

            stream.on("data", (chunk) => {
                this.bytesDone += chunk.length;
                this._report(file.relPath);
            });

            writeAttempted = true;
            await this.dest.writeFile(destPath, stream);
            await done;
        } catch (err) {
            if (writeAttempted) await this._removePartial(destPath);
            if (isNotFound(err)) {
                // The spec wants a source file that vanished between walk and read counted as
                // skipped, not fatal, and a move must not delete anything after this. Pull it
                // out of the totals too, exactly like a conflict skip in _run — otherwise the
                // final progress frame stays under 100% even though the transfer succeeded.
                this.filesSkipped += 1;
                this.sourceIncomplete = true;
                this.bytesTotal -= file.size;
                this.filesTotal -= 1;
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

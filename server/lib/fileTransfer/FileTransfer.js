const { Transform } = require("node:stream");
const { walk, join, WalkCancelledError } = require("./walk");

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
    constructor({ source, dest, destCleanup, onProgress, onConflict, now, setIntervalFn, clearIntervalFn }) {
        this.source = source;
        this.dest = dest;
        this.destCleanup = destCleanup || dest;
        this.onProgress = onProgress || (() => {});
        this.onConflict = onConflict || (async () => "overwrite");
        this.now = now || Date.now;
        this.setIntervalFn = setIntervalFn || setInterval;
        this.clearIntervalFn = clearIntervalFn || clearInterval;

        this.action = "copy";
        this.conflictMode = "ask";
        this.bytesTotal = 0;
        this.filesTotal = 0;
        this.bytesDone = 0;
        this.filesDone = 0;
        this.filesSkipped = 0;
        this.sourceIncomplete = false;
        this.leftovers = [];
        this.cancelled = false;
        this._cancelHooks = new Set();
    }

    cancel() {
        this.cancelled = true;
        for (const hook of this._cancelHooks) hook();
    }

    // A cancel during a conflict pause has no running _copyFile hook to attach to — without this
    // race run() would sit there until the conflict timeout.
    async _ask(info) {
        let hook;
        try {
            return await Promise.race([
                this.onConflict(info),
                new Promise((resolve) => {
                    hook = () => resolve("abort");
                    this._cancelHooks.add(hook);
                    if (this.cancelled) hook();
                }),
            ]);
        } finally {
            this._cancelHooks.delete(hook);
        }
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
        let plan;
        try {
            plan = await walk(this.source, paths, { isCancelled: () => this.cancelled });
        } catch (err) {
            // Identify the cancel by what the error IS, not by this.cancelled: the top-level loop
            // in walk() (path validation, stat, the final duplicate-target check) has no
            // cancellation checkpoint of its own, so a genuine walk error can perfectly well be
            // thrown while this.cancelled is already true — that must still fail the transfer.
            if (err instanceof WalkCancelledError) return this._result(true);
            throw err;
        }
        this.bytesTotal = plan.totalBytes;
        this.filesTotal = plan.files.length;
        this.filesSkipped = plan.skipped.length;

        if (this.cancelled) return this._result(true);
        await this._ensureDirs(destination, plan.dirs);

        const transferred = [];

        for (const file of plan.files) {
            if (this.cancelled) return this._result(true);
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

            const copied = await this._copyFile(file, destPath);
            // Cancellation during _copyFile itself only surfaces here: the loop has no further
            // iteration to catch it at the top when the cancelled file was the last one.
            if (this.cancelled) return this._result(true);
            // _copyFile returns false for a skipped (vanished) source file — those must not be
            // deleted from the source later, so they never enter `transferred`.
            if (copied) transferred.push({ srcPath: file.srcPath, destPath, size: file.size });
        }

        if (this.action === "move") {
            await this._finishMove(transferred, plan);
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

    async _finishMove(transferred, plan) {
        if (this.sourceIncomplete) {
            throw new Error("Verification incomplete: a source file vanished during the transfer, nothing was deleted");
        }
        await this._verifyAll(transferred);

        // Deliberately not cancellable from here on: verification is done, and a half-finished
        // cleanup produces exactly the inconsistent state this method exists to avoid.
        const failed = [];
        for (const item of transferred) {
            try { await this.source.unlink(item.srcPath); } catch { failed.push(item.srcPath); }
        }
        // rmdir(path, true) would recursively delete everything below the source folder — also the
        // skipped entries and anything created since the walk. Only what was verified may go, so
        // directories are removed empty and from the inside out. One that stays has content left.
        for (const dir of [...plan.dirs].reverse()) {
            try { await this.source.rmdir(dir.srcPath, false); } catch { this.leftovers.push(dir.srcPath); }
        }

        if (failed.length > 0) {
            // Every file is verified at the destination — this is not data loss but an incompletely
            // cleaned up source. The message has to say so distinguishably.
            const err = new Error(`Transfer complete, but the source was not fully removed: ${failed.join(", ")}`);
            err.dataIsSafe = true;
            throw err;
        }
    }

    async _verifyAll(items) {
        const useChecksum = Boolean(this.source.supportsChecksum && this.dest.supportsChecksum);

        for (const item of items) {
            const target = await this.dest.stat(item.destPath).catch(() => null);
            if (!target || target.size !== item.size) {
                throw new Error(`Verification failed: ${item.destPath}`);
            }
            if (useChecksum) {
                const [srcHash, destHash] = await Promise.all([
                    this.source.checksum(item.srcPath, "sha256"),
                    this.dest.checksum(item.destPath, "sha256"),
                ]);
                if (srcHash !== destHash) throw new Error(`Verification failed: ${item.destPath}`);
            }
        }
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
        // Only a write attempt that actually reached the destination can have left a partial file
        // behind. readFile() can fail before that point — reporting that as a leftover would be a
        // false claim to the user.
        let writeAttempted = false;
        let stream = null;
        let counted = null;
        let timer = null;
        let watchdogError = null;
        let onCancel = null;
        // Narrower than this.cancelled: only set by our own onCancel hook, so the catch block
        // below can tell "the cancel hook actually fired" apart from "cancelled happens to be
        // true for some unrelated reason" — a future bug (e.g. a TDZ ReferenceError) must still
        // surface as a thrown error instead of being reported as a clean cancellation.
        let cancelledMidCopy = false;

        try {
            const opened = this.source.readFile(file.srcPath);
            stream = opened.stream;
            const done = opened.done;

            let lastDataAt = this.now();
            let sourceEnded = false;
            let bytesThisFile = 0;

            let rejectWatchdog;
            const watchdogFailed = new Promise((_, reject) => { rejectWatchdog = reject; });
            watchdogFailed.catch(() => {});

            // Counting the bytes with stream.on("data") would put the source into flowing mode
            // right here, while the real destination only attaches its consumer after a full round
            // trip (EngineSftpClient.writeFile awaits the WriteBegin ack first). Everything the
            // source delivers inside that window would be counted and then dropped — a silently
            // truncated file at the destination, and an outright hang whenever the source ends
            // inside the window, because "end" had already fired before writeFile listened for it.
            // A counting Transform fed by pipe() sees exactly the same bytes but keeps them, with
            // backpressure, for whoever consumes it — however late that is.
            counted = new Transform({
                transform: (chunk, _encoding, callback) => {
                    lastDataAt = this.now();
                    bytesThisFile += chunk.length;
                    if (bytesThisFile > file.size + MAX_SIZE_OVERRUN) {
                        // No callback: fail() destroys both streams, so this chunk has nowhere to
                        // go and the transfer is over anyway.
                        fail("Source delivered more data than announced, transfer aborted");
                        return;
                    }
                    this.bytesDone += chunk.length;
                    this._report(file.relPath);
                    callback(null, chunk);
                },
            });
            // fail() destroys both streams, which emits "error". Without a listener that terminates
            // the whole process with an uncaught exception — the failure is reported through
            // watchdogFailed instead. EngineSftpClient.readFile attaches the same guard on its own
            // stream, but the interface does not require it, so FileTransfer must not rely on it.
            // pipe() never forwards a source error, so it has to be handed on explicitly: the
            // destination waits on `counted` and would otherwise sit there for an "end" that can
            // no longer come.
            stream.on("error", (err) => { if (!counted.destroyed) counted.destroy(err); });
            counted.on("error", () => {});

            const fail = (message) => {
                if (watchdogError) return;
                watchdogError = new Error(message);
                stream.destroy(watchdogError);
                if (!counted.destroyed) counted.destroy(watchdogError);
                rejectWatchdog(watchdogError);
            };

            // Must come after fail(): onCancel calls it, and the synchronous self-call below would
            // otherwise hit the temporal dead zone.
            onCancel = () => {
                cancelledMidCopy = true;
                fail("Transfer cancelled");
            };
            this._cancelHooks.add(onCancel);
            if (this.cancelled) onCancel();

            // After "end" a standstill is no longer a stalled read but the destination's WriteEnd
            // flush, which may take up to WRITE_END_TIMEOUT (120 s).
            stream.on("end", () => { sourceEnded = true; });
            stream.pipe(counted);

            timer = this.setIntervalFn(() => {
                // readableLength alone is not enough: the PassThrough caps it at its highWaterMark
                // (16 KB) and piles the rest up on the writable side. The counting Transform in
                // between holds real bytes in two buffers of its own, so they count as well.
                const sourceBuffered = stream.readableLength + stream.writableLength;
                if (sourceBuffered + counted.readableLength + counted.writableLength > MAX_BUFFER) {
                    fail("Destination too slow, transfer aborted");
                } else if (!sourceEnded && sourceBuffered === 0 && this.now() - lastDataAt > READ_STALL_TIMEOUT) {
                    // Bytes still queued on the source side mean the source did deliver and the
                    // hold-up is downstream — that is a slow destination, not a stalled read, and
                    // the buffer check above is the one that has to decide about it.
                    fail("Read stalled, transfer aborted");
                }
            }, WATCHDOG_INTERVAL);

            // Both promises need a handler before Promise.race drops one of them: fail() destroys
            // the source stream, writeFile rejects in turn, and without a handler Node terminates
            // the process with unhandledRejection.
            writeAttempted = true;
            const writePromise = (async () => this.dest.writeFile(destPath, counted))();
            writePromise.catch(() => {});
            const donePromise = Promise.resolve(done);
            donePromise.catch(() => {});

            await Promise.race([writePromise, watchdogFailed]);
            await Promise.race([donePromise, watchdogFailed]);
        } catch (err) {
            if (writeAttempted) await this._removePartial(destPath);
            // Cancelling is not an error: run() returns cancelled: true instead of throwing.
            // Scoped to our own hook firing, not just this.cancelled — otherwise an unrelated bug
            // that happens to throw while a cancel is pending would be silently swallowed here.
            if (cancelledMidCopy) return false;
            if (isNotFound(err)) {
                // A source file that vanished between walk and read counts as skipped, not fatal,
                // and a move must not delete anything after this. Pull it out of the totals too,
                // exactly like a conflict skip in _run.
                this.filesSkipped += 1;
                this.sourceIncomplete = true;
                this.bytesTotal -= file.size;
                this.filesTotal -= 1;
                this._report(file.relPath);
                return false;
            }
            throw watchdogError || err;
        } finally {
            if (timer !== null) this.clearIntervalFn(timer);
            // There is no read abort in the protocol: the pending entry lives until FileEnd and
            // onFileData keeps writing unconditionally. Without destroy() the buffer grows on
            // unmeasured after an error — the watchdog is already stopped here.
            if (stream && !stream.destroyed) stream.destroy();
            if (counted && !counted.destroyed) counted.destroy();
            if (onCancel) this._cancelHooks.delete(onCancel);
        }

        if (this.cancelled) return false;
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

        return this._ask({
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

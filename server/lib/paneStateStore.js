const { normalizeBookmarkPath } = require("./bookmarkPath");

// Matches the STRING(1024) of file_pane_states.lastPath. The engine lets paths up to 4096 bytes
// through, and PATH_SYNC has no route and therefore no 400 to answer with - so a path that does
// not fit is dropped here rather than reaching a database that would either truncate it (SQLite)
// or reject the whole upsert (MySQL in strict mode).
const MAX_REMEMBERED_PATH = 1024;

// The same guard validations/bookmarks.js applies to a bookmark path, for the same reason it gives:
// a NUL truncates the path on its way to the C engine, so a remembered path carrying one would
// silently open somewhere else. PATH_SYNC has no route and therefore no 400 - it is dropped here.
const HAS_CONTROL_CHAR = /[\u0000-\u001F\u007F]/;

const createPaneStateWriter = ({ upsert, delayMs = 2000, onError = () => {} }) => {
    let timer = null;
    let pending = null;
    let closed = false;
    // Serializes the writes. Two upserts in flight on the same key let the connection pool decide
    // which path ends up in the row, and "the last one written wins" stops being true.
    let inFlight = Promise.resolve();

    const run = () => {
        timer = null;
        const job = pending;
        if (!job) return inFlight;
        // Claimed here, not after the write returns. Leaving it in place lets the next run() -
        // flush racing the timer that already started this very job - queue the same upsert a
        // second time, and "the last one written wins" turns into "the last one written twice".
        pending = null;
        inFlight = inFlight.then(async () => {
            try {
                await upsert(job.key, job.path);
            } catch (error) {
                // Put back only if nothing newer has taken its place and the socket is still there:
                // a locked database is exactly the moment worth remembering, but after flush()
                // there is no one left to retry for.
                if (pending === null && !closed) pending = job;
                onError(error);
            }
        });
        return inFlight;
    };

    return {
        schedule(key, path) {
            if (closed) return;
            if (!key?.accountId || !key?.entryId) return;
            const normalized = normalizeBookmarkPath(path);
            if (Buffer.byteLength(normalized, "utf8") > MAX_REMEMBERED_PATH) return;
            if (HAS_CONTROL_CHAR.test(normalized)) return;
            pending = { key, path: normalized };
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { run(); }, delayMs);
        },
        // Called from handleClose: "navigate there and close the tab" is the most common run of the
        // whole feature, and without flushing it is exactly the last step that is lost.
        async flush() {
            closed = true;
            if (timer) { clearTimeout(timer); timer = null; }
            await run();
            // Awaits the chain, not just this job: a write the timer started a moment ago is still
            // the last step the user took, and handleClose must not outrun it.
            await inFlight;
        },
    };
};

// Exported and used, not exported for the test alone: sftpWS.js builds its key through this
// function, so the test drives the same code the unique index depends on. entryId arrives already
// resolved (sftpWS.js:245) - deriving it a second time would hang the index on two spellings.
const buildPaneStateKey = (serverSession, entryId, identityId) => ({
    accountId: serverSession?.accountId, entryId, identityId,
});

module.exports = { createPaneStateWriter, buildPaneStateKey, MAX_REMEMBERED_PATH };

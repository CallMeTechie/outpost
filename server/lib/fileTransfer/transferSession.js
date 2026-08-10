// Both helpers take their time functions from outside. Without that neither the conflict timeout
// nor the progress throttle can be tested without letting real time pass — and a test that merely
// runs slower instead of failing proves nothing. The real setTimeout/clearTimeout are only the
// default fallback, wired in here so a caller that does not need fake timers gets working
// behavior for free; the function body below never reaches for the globals directly, only for
// whatever setTimeoutFn/clearTimeoutFn resolves to.
const createConflictBroker = ({ send, timeoutMs, maxRounds = 100,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) => {
    let waiting = null;      // the single open question: { file, resolve, timer }
    let applyAll = null;     // null = nothing remembered yet; any string (even "") counts as set
    let cancelled = false;
    let rounds = 0;

    // The only place that ever settles a question's promise. Guarded by entry.done rather than
    // "something is open": a timer (or any other reference) captured for an earlier question
    // must never be able to reach past it and settle whatever replaced it. Once entry.done is
    // false we know this entry is still the current waiting slot (nothing else can clear
    // entry.done or reassign waiting without going through this same function first), so a
    // single per-entry flag is enough to guard both decisions below.
    const finish = (entry, choice) => {
        if (entry.done) return;
        entry.done = true;
        if (waiting === entry) waiting = null;
        // Resolve before clearing the timer: if the injected clearTimeoutFn itself throws, the
        // promise must already be settled, or the question becomes unanswerable forever.
        entry.resolve(choice);
        clearTimeoutFn(entry.timer);
    };

    return {
        ask(info) {
            // Only one question can be open at a time. A new ask() while the previous one is
            // still unanswered means the caller moved on without waiting for it — the intended
            // caller always awaits one ask() before starting the next, so this only fires on a
            // caller bug. Treat the abandoned question as aborted (same outcome as cancel())
            // instead of silently losing its promise forever.
            if (waiting) finish(waiting, "abort");
            if (cancelled) return Promise.resolve("abort");
            if (applyAll !== null) return Promise.resolve(applyAll);
            // Each round holds two engine connections for up to timeoutMs. Without a cap a client
            // can keep them alive indefinitely by answering just before every timeout.
            if (rounds >= maxRounds) return Promise.resolve("abort");
            rounds += 1;
            const entry = { file: info.file, resolve: null, timer: null, done: false };
            return new Promise((resolve, reject) => {
                entry.resolve = resolve;
                entry.timer = setTimeoutFn(() => finish(entry, "abort"), timeoutMs);
                waiting = entry;
                try {
                    send(info);
                } catch (err) {
                    // A closed socket throws here in practice. This is a transport failure, not an
                    // answer, so it rejects with the real error instead of going through finish().
                    // But send() can call back into this broker before it throws — a reentrant
                    // ask() would already have finished this entry (superseding it), or send()
                    // could have answered its own question via resolve() and only failed on some
                    // later write. Either way entry.done is already true, so skip out instead of
                    // re-clearing an already-cleared timer or nulling a waiting slot that has since
                    // moved on to a different question.
                    if (entry.done) return;
                    entry.done = true;
                    if (waiting === entry) waiting = null;
                    reject(err);
                    clearTimeoutFn(entry.timer);
                }
            });
        },

        resolve(payload) {
            // This is the entry point for data coming straight from the client in the follow-up
            // task; a missing or malformed payload must not throw synchronously out of the
            // message handler.
            const { file, choice, applyToAll } = payload || {};
            // A stale dialog or a double click can answer for a file we are no longer waiting on
            // (or for none at all) — dropping it keeps the transfer paused instead of deciding
            // the wrong file, and stops a stray applyToAll from being remembered for nothing.
            // "!file" also stops the "payload || {}" fallback above from turning a missing/blank
            // payload into an accidental match: without it, an empty resolve() call would decide
            // a file-less question, because undefined (no file given) equals undefined (no file
            // asked about) — a real file name is never empty, so requiring one is always safe.
            if (!waiting || !file || waiting.file !== file) return;
            // "abort" ends the transfer; remembering it would be meaningless.
            if (applyToAll && choice !== "abort") applyAll = choice;
            finish(waiting, choice);
        },

        // A pause is a plain in-memory promise: closing the transfer's clients cannot reach it.
        // Without this a cancel during an open question would wait out the whole timeout.
        cancel() {
            cancelled = true;
            if (waiting) finish(waiting, "abort");
        },
    };
};

// Same reasoning as above: Date.now is only the default fallback for a caller that has no need
// for a fake clock; the body below only ever calls the local now(), never the global.
const createProgressThrottle = ({ send, intervalMs, now = Date.now }) => {
    let lastSentAt = -Infinity;
    return {
        report(progress) {
            if (now() - lastSentAt < intervalMs) return;
            lastSentAt = now();
            send(progress);
        },
        // Always sent, whatever the throttle says: without it the final frame is dropped and the
        // display stays below 100 % on a transfer that finished.
        flush(progress) {
            lastSentAt = now();
            send(progress);
        },
    };
};

module.exports = { createConflictBroker, createProgressThrottle };

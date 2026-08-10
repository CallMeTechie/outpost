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

    // The only place that ever settles a question's promise. Bound to a specific entry by
    // identity rather than "something is open": a timer (or any other reference) captured for an
    // earlier question must never be able to reach past it and settle whatever replaced it.
    const finish = (entry, choice) => {
        if (waiting !== entry) return;
        waiting = null;
        clearTimeoutFn(entry.timer);
        entry.resolve(choice);
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
            const entry = { file: info.file, resolve: null, timer: null };
            return new Promise((resolve, reject) => {
                entry.resolve = resolve;
                entry.timer = setTimeoutFn(() => finish(entry, "abort"), timeoutMs);
                waiting = entry;
                try {
                    send(info);
                } catch (err) {
                    // A closed socket throws here in practice. This is a transport failure, not an
                    // answer, so it rejects with the real error instead of going through finish();
                    // but the timer and slot still need the same cleanup finish() would have done,
                    // or the timer keeps running and a later real question inherits both.
                    waiting = null;
                    clearTimeoutFn(entry.timer);
                    reject(err);
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
            if (!waiting || waiting.file !== file) return;
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

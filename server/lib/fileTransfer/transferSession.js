// Both helpers take their time functions from outside. Without that neither the conflict timeout
// nor the progress throttle can be tested without letting real time pass — and a test that merely
// runs slower instead of failing proves nothing. There is deliberately no fallback to the real
// setTimeout/clearTimeout here: a default would still reach the global timer and reintroduce the
// same untestable path, so callers (Task 7) must always pass them in.
const createConflictBroker = ({ send, timeoutMs, maxRounds = 100, setTimeoutFn, clearTimeoutFn }) => {
    let waiting = null;      // { file, resolve, timer }
    let applyAll = null;     // a remembered decision, never "abort"
    let cancelled = false;
    let rounds = 0;

    const settle = (choice) => {
        if (!waiting) return;
        const { resolve, timer } = waiting;
        waiting = null;
        clearTimeoutFn(timer);
        resolve(choice);
    };

    return {
        ask(info) {
            if (cancelled) return Promise.resolve("abort");
            if (applyAll) return Promise.resolve(applyAll);
            // Each round holds two engine connections for up to timeoutMs. Without a cap a client
            // can keep them alive indefinitely by answering just before every timeout.
            if (rounds >= maxRounds) return Promise.resolve("abort");
            rounds += 1;
            return new Promise((resolve) => {
                const timer = setTimeoutFn(() => settle("abort"), timeoutMs);
                waiting = { file: info.file, resolve, timer };
                send(info);
            });
        },

        resolve({ file, choice, applyToAll }) {
            // A stale dialog or a double click can answer for a file we are no longer waiting on —
            // dropping it keeps the transfer paused instead of deciding the wrong file.
            if (!waiting || waiting.file !== file) return;
            // "abort" ends the transfer; remembering it would be meaningless.
            if (applyToAll && choice !== "abort") applyAll = choice;
            settle(choice);
        },

        // A pause is a plain in-memory promise: closing the transfer's clients cannot reach it.
        // Without this a cancel during an open question would wait out the whole timeout.
        cancel() {
            cancelled = true;
            settle("abort");
        },
    };
};

// Same reasoning as above: no default here falls back to Date.now, so the throttle stays
// deterministic under test whenever a caller forgets to pass a clock explicitly.
const createProgressThrottle = ({ send, intervalMs, now }) => {
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

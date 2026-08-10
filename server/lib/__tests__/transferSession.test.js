const test = require("node:test");
const assert = require("node:assert");
const { createConflictBroker, createProgressThrottle } = require("../fileTransfer/transferSession");

const broker = (over = {}) => createConflictBroker({
    send: () => {}, timeoutMs: 1000, maxRounds: 100,
    setTimeoutFn: () => 1, clearTimeoutFn: () => {}, ...over,
});

// A promise-vs-deadline race, using the real setTimeout (this is test-only tooling, not the
// module under test). A broker regression that leaks a promise would otherwise report only by
// running out the whole per-test timeout with no failed assertion — slow and undiagnosable.
// This turns that into a fast, explicit "did not settle" result within `ms`.
const settledWithin = (promise, ms = 200) => Promise.race([
    promise.then((value) => ({ settled: true, value })),
    new Promise((resolve) => { setTimeout(() => resolve({ settled: false }), ms); }),
]);

test("a decision is passed through", async () => {
    const sent = [];
    const b = broker({ send: (info) => sent.push(info) });
    const pending = b.ask({ file: "a.txt" });
    b.resolve({ file: "a.txt", choice: "skip" });
    assert.strictEqual(await pending, "skip");
    assert.strictEqual(sent.length, 1);
});

test("applyToAll answers later files without asking again", async () => {
    const sent = [];
    const b = broker({ send: (info) => sent.push(info) });
    const first = b.ask({ file: "a.txt" });
    b.resolve({ file: "a.txt", choice: "overwrite", applyToAll: true });
    assert.strictEqual(await first, "overwrite");
    assert.strictEqual(await b.ask({ file: "b.txt" }), "overwrite");
    assert.strictEqual(sent.length, 1, "the second file must not be asked about");
});

test("applyToAll is ignored together with abort", async () => {
    const sent = [];
    const b = broker({ send: (info) => sent.push(info) });
    const first = b.ask({ file: "a.txt" });
    b.resolve({ file: "a.txt", choice: "abort", applyToAll: true });
    assert.strictEqual(await first, "abort");
    const second = b.ask({ file: "b.txt" });
    b.resolve({ file: "b.txt", choice: "skip" });
    assert.strictEqual(await second, "skip");
    assert.strictEqual(sent.length, 2);
});

// Guards against a truthy-check regression: "applyAll" is only unset while it is literally null,
// so a remembered empty-string choice must still short-circuit the next file without asking.
test("applyToAll is remembered even when the choice is an empty string", () => {
    const sent = [];
    const b = broker({ send: (info) => sent.push(info) });
    const first = b.ask({ file: "a.txt" });
    b.resolve({ file: "a.txt", choice: "", applyToAll: true });
    const second = b.ask({ file: "b.txt" });
    assert.strictEqual(sent.length, 1, "a remembered empty-string choice must short-circuit without asking again");
    return Promise.all([first, second]).then(([a, b2]) => {
        assert.strictEqual(a, "");
        assert.strictEqual(b2, "");
    });
});

test("a resolve for the wrong file is ignored", async () => {
    const b = broker();
    const pending = b.ask({ file: "a.txt" });
    b.resolve({ file: "other.txt", choice: "overwrite" });
    b.resolve({ file: "a.txt", choice: "skip" });
    assert.strictEqual(await pending, "skip");
});

// resolve() is fed straight from client input once wired up; a missing or malformed payload must
// not throw synchronously out of the message handler that will call it.
test("resolve() with a missing or malformed payload does not throw", async () => {
    const b = broker();
    const pending = b.ask({ file: "a.txt" });
    b.resolve();
    b.resolve(null);
    b.resolve({});
    b.resolve({ file: "a.txt", choice: "skip" });
    assert.strictEqual(await pending, "skip");
});

// The "payload || {}" fallback above must only stop a synchronous throw, not become
// decision-relevant itself: a file-less payload is never allowed to match a file-less question,
// even though undefined (given) trivially equals undefined (waited on).
test("resolve() never matches a question by both having no file", async () => {
    const b = broker();
    const pending = b.ask({}); // a question with no file of its own
    b.resolve();
    b.resolve({});
    b.resolve({ file: undefined, choice: "skip" });
    assert.deepStrictEqual(await settledWithin(pending), { settled: false },
        "a file-less resolve() must never decide a file-less question");
});

test("no answer within the window aborts", async () => {
    let fire;
    const b = broker({ setTimeoutFn: (fn) => { fire = fn; return 1; } });
    const pending = b.ask({ file: "a.txt" });
    fire();
    assert.strictEqual(await pending, "abort");
});

// Cancelling during an open question must not wait for the 120 s window. Bounded by
// settledWithin: a regression that leaves this promise pending would otherwise report by
// running out the test timeout instead of failing.
test("cancel resolves a waiting question immediately", async () => {
    const b = broker();
    const pending = b.ask({ file: "a.txt" });
    b.cancel();
    assert.deepStrictEqual(await settledWithin(pending), { settled: true, value: "abort" });
});

test("cancel before any question makes later questions abort at once", async () => {
    const sent = [];
    const b = broker({ send: (info) => sent.push(info) });
    b.cancel();
    assert.deepStrictEqual(await settledWithin(b.ask({ file: "a.txt" })), { settled: true, value: "abort" });
    assert.strictEqual(sent.length, 0, "a cancelled transfer must not still ask");
});

// Holding two connections open for 120 s per file is a resource hold; cap the rounds.
test("too many conflict rounds abort the transfer", async () => {
    const b = broker({ maxRounds: 2 });
    for (let i = 0; i < 2; i += 1) {
        const p = b.ask({ file: `f${i}` });
        b.resolve({ file: `f${i}`, choice: "skip" });
        assert.deepStrictEqual(await settledWithin(p), { settled: true, value: "skip" });
    }
    assert.deepStrictEqual(await settledWithin(b.ask({ file: "f2" })), { settled: true, value: "abort" });
});

// The broker holds exactly one waiting slot. A second ask() before the first is answered used to
// overwrite it silently, leaking the first promise forever. The chosen policy: treat the
// abandoned question as aborted, the same outcome cancel() produces, instead of losing it.
test("a new ask() abandons a still-open question with abort instead of losing it silently", async () => {
    const b = broker();
    let firstResult;
    b.ask({ file: "a.txt" }).then((choice) => { firstResult = choice; });
    const second = b.ask({ file: "b.txt" });
    b.resolve({ file: "b.txt", choice: "skip" });
    assert.strictEqual(await second, "skip");
    assert.strictEqual(firstResult, "abort", "the abandoned question must still settle, as abort");
});

// The other half of the same fix: settling is bound to the specific question by identity, so a
// timer captured for an abandoned question can never reach into whatever replaced it, even if
// clearTimeoutFn (mocked here as a no-op, as a broken/late clear would behave) fails to stop it.
test("a stale timer from a superseded question cannot abort the current one", async () => {
    let fireFirst;
    let calls = 0;
    const setTimeoutFn = (fn) => {
        calls += 1;
        if (calls === 1) fireFirst = fn;
        return calls;
    };
    const b = createConflictBroker({
        send: () => {}, timeoutMs: 1000, setTimeoutFn, clearTimeoutFn: () => {},
    });
    let firstResult;
    b.ask({ file: "a.txt" }).then((choice) => { firstResult = choice; });
    const second = b.ask({ file: "b.txt" });
    fireFirst(); // the orphaned timer for "a.txt" fires anyway
    b.resolve({ file: "b.txt", choice: "skip" });
    assert.strictEqual(await second, "skip", "the stale timer must not touch the question that replaced it");
    assert.strictEqual(firstResult, "abort");
});

// The real failure mode is a client whose WebSocket already closed. Without cleanup here the
// timer keeps running and the slot stays occupied, so the next real question inherits both.
test("a throwing send rejects and does not leave the slot occupied", async () => {
    const cleared = [];
    let shouldThrow = true;
    const sent = [];
    const b = createConflictBroker({
        send: (info) => { if (shouldThrow) throw new Error("socket closed"); sent.push(info); },
        timeoutMs: 1000,
        setTimeoutFn: () => 7,
        clearTimeoutFn: (t) => cleared.push(t),
    });
    await assert.rejects(() => b.ask({ file: "a.txt" }), /socket closed/);
    assert.deepStrictEqual(cleared, [7], "the timer for the failed send must be cleared");
    shouldThrow = false;
    const pending = b.ask({ file: "b.txt" });
    assert.strictEqual(sent.length, 1, "the next question must still reach the client");
    b.resolve({ file: "b.txt", choice: "skip" });
    assert.strictEqual(await pending, "skip");
});

// The catch cleanup used to null the shared waiting slot unconditionally. If send() calls back
// into the broker before throwing (a reentrant ask() for the next file), that reentrant call has
// already superseded and finished this entry, and moved waiting on to its own. Nulling waiting
// again here would then wipe out the *new* question instead of the failed one.
test("a reentrant ask() inside a throwing send() is not clobbered by that send's cleanup", async () => {
    const sentB = [];
    let b;
    let reentered;
    b = createConflictBroker({
        send: (info) => {
            if (info.file === "a.txt") {
                reentered = b.ask({ file: "b.txt" });
                throw new Error("socket closed");
            }
            sentB.push(info);
        },
        timeoutMs: 1000, setTimeoutFn: () => 1, clearTimeoutFn: () => {},
    });
    const first = b.ask({ file: "a.txt" });
    assert.deepStrictEqual(await settledWithin(first), { settled: true, value: "abort" },
        "superseded by the reentrant question before send() ever throws");
    assert.strictEqual(sentB.length, 1, "the reentrant question must have reached the client");
    b.resolve({ file: "b.txt", choice: "skip" });
    assert.deepStrictEqual(await settledWithin(reentered), { settled: true, value: "skip" },
        "the reentrant question must still be answerable, not clobbered by a.txt's failed cleanup");
});

// Symmetric case: send() answers its own question and only fails afterwards (e.g. on some later
// ack write). The transport error has nowhere to go once the promise already settled, but the
// timer must still only be cleared the one time finish() already cleared it.
test("a self-answering send() that also throws clears its timer only once", async () => {
    const cleared = [];
    let b;
    b = createConflictBroker({
        send: (info) => {
            b.resolve({ file: info.file, choice: "skip" });
            throw new Error("late socket error");
        },
        timeoutMs: 1000, setTimeoutFn: () => 9, clearTimeoutFn: (t) => cleared.push(t),
    });
    const pending = b.ask({ file: "a.txt" });
    assert.strictEqual(await pending, "skip", "the self-answer wins; the later throw cannot un-resolve it");
    assert.deepStrictEqual(cleared, [9], "the timer must only be cleared once");
});

test("resolving a question clears its pending timer", async () => {
    const cleared = [];
    const b = createConflictBroker({
        send: () => {}, timeoutMs: 1000, setTimeoutFn: () => 42, clearTimeoutFn: (t) => cleared.push(t),
    });
    const pending = b.ask({ file: "a.txt" });
    b.resolve({ file: "a.txt", choice: "skip" });
    await pending;
    assert.deepStrictEqual(cleared, [42]);
});

// If the waiting slot were not cleared on settle, a late duplicate resolve() for the same file
// would still pass the file check and clear the (already cleared) timer a second time.
test("a late duplicate resolve after a question is already settled has no further effect", async () => {
    const cleared = [];
    const b = createConflictBroker({
        send: () => {}, timeoutMs: 1000, setTimeoutFn: () => 42, clearTimeoutFn: (t) => cleared.push(t),
    });
    const pending = b.ask({ file: "a.txt" });
    b.resolve({ file: "a.txt", choice: "skip" });
    b.resolve({ file: "a.txt", choice: "overwrite" });
    assert.strictEqual(await pending, "skip");
    assert.deepStrictEqual(cleared, [42], "the timer must only be cleared once");
});

test("resolve() with applyToAll is ignored when there is no open question", async () => {
    const sent = [];
    const b = broker({ send: (info) => sent.push(info) });
    b.resolve({ file: "a.txt", choice: "overwrite", applyToAll: true }); // nothing is waiting
    const answer = b.ask({ file: "b.txt" });
    b.resolve({ file: "b.txt", choice: "skip" });
    assert.strictEqual(sent.length, 1, "the real question must still have been asked, not short-circuited");
    assert.strictEqual(await answer, "skip", "a stray resolve() must not have set a remembered decision");
});

// Pins the default fallback to the real setTimeout/clearTimeout. There is no wiring of this
// broker into a transfer yet — that lands in a later task — but its plan omits
// setTimeoutFn/clearTimeoutFn, so a caller built against that plan must still get a working
// broker instead of a TypeError the first time a real transfer hits a conflict. cancel() settles
// the pending question at once, so this does not wait for the real 1000 ms window.
test("the broker works with the default timers when none are supplied", async () => {
    const sent = [];
    const b = createConflictBroker({ send: (info) => sent.push(info), timeoutMs: 1000 });
    const pending = b.ask({ file: "a.txt" });
    b.cancel();
    assert.strictEqual(await pending, "abort");
    assert.strictEqual(sent.length, 1);
});

// Same pinning for the throttle's default clock: the same later-task plan may omit now, so
// flush() must not throw when it falls back to Date.now.
test("the throttle works with the default clock when now is not supplied", () => {
    const sent = [];
    const throttle = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 250 });
    throttle.flush({ filesDone: 1 });
    assert.strictEqual(sent.length, 1);
});

test("the throttle drops intermediate frames but never the last one", () => {
    let now = 0;
    const sent = [];
    const throttle = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 250, now: () => now });
    throttle.report({ filesDone: 0 });
    throttle.report({ filesDone: 1 });
    now = 300;
    throttle.report({ filesDone: 2 });
    throttle.flush({ filesDone: 3 });
    assert.deepStrictEqual(sent.map((p) => p.filesDone), [0, 2, 3]);
});

// The boundary itself counts as due (a strict "<" check), not just strictly-after.
test("the throttle sends again exactly at the interval boundary", () => {
    let now = 0;
    const sent = [];
    const throttle = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 250, now: () => now });
    throttle.report({ filesDone: 0 });
    now = 250;
    throttle.report({ filesDone: 1 });
    assert.deepStrictEqual(sent.map((p) => p.filesDone), [0, 1]);
});

// Proves flush() itself sets the throttle window (not just that it sends): a report() right
// after must still be suppressed, even though no report() ever ran before this flush().
test("flush initializes the throttle window even without a preceding report", () => {
    let now = 0;
    const sent = [];
    const throttle = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 250, now: () => now });
    throttle.flush({ filesDone: 1 });
    now = 100; // still inside the window flush() just opened
    throttle.report({ filesDone: 2 });
    assert.deepStrictEqual(sent.map((p) => p.filesDone), [1]);
});

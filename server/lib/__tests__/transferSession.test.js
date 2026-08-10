const test = require("node:test");
const assert = require("node:assert");
const { createConflictBroker, createProgressThrottle } = require("../fileTransfer/transferSession");

const broker = (over = {}) => createConflictBroker({
    send: () => {}, timeoutMs: 1000, maxRounds: 100,
    setTimeoutFn: () => 1, clearTimeoutFn: () => {}, ...over,
});

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

test("a resolve for the wrong file is ignored", async () => {
    const b = broker();
    const pending = b.ask({ file: "a.txt" });
    b.resolve({ file: "other.txt", choice: "overwrite" });
    b.resolve({ file: "a.txt", choice: "skip" });
    assert.strictEqual(await pending, "skip");
});

test("no answer within the window aborts", async () => {
    let fire;
    const b = broker({ setTimeoutFn: (fn) => { fire = fn; return 1; } });
    const pending = b.ask({ file: "a.txt" });
    fire();
    assert.strictEqual(await pending, "abort");
});

// Cancelling during an open question must not wait for the 120 s window.
test("cancel resolves a waiting question immediately", async () => {
    const b = broker();
    const pending = b.ask({ file: "a.txt" });
    b.cancel();
    assert.strictEqual(await pending, "abort");
});

test("cancel before any question makes later questions abort at once", async () => {
    const sent = [];
    const b = broker({ send: (info) => sent.push(info) });
    b.cancel();
    assert.strictEqual(await b.ask({ file: "a.txt" }), "abort");
    assert.strictEqual(sent.length, 0, "a cancelled transfer must not still ask");
});

// Holding two connections open for 120 s per file is a resource hold; cap the rounds.
test("too many conflict rounds abort the transfer", async () => {
    const b = broker({ maxRounds: 2 });
    for (let i = 0; i < 2; i += 1) {
        const p = b.ask({ file: `f${i}` });
        b.resolve({ file: `f${i}`, choice: "skip" });
        await p;
    }
    assert.strictEqual(await b.ask({ file: "f2" }), "abort");
});

// Pins the default fallback to the real setTimeout/clearTimeout: production wiring omits
// setTimeoutFn/clearTimeoutFn, so a caller without them must still get a working broker instead
// of a TypeError the first time a real transfer hits a conflict. cancel() settles the pending
// question at once, so this does not wait for the real 1000 ms window.
test("the broker works with the default timers when none are supplied", async () => {
    const sent = [];
    const b = createConflictBroker({ send: (info) => sent.push(info), timeoutMs: 1000 });
    const pending = b.ask({ file: "a.txt" });
    b.cancel();
    assert.strictEqual(await pending, "abort");
    assert.strictEqual(sent.length, 1);
});

// Same pinning for the throttle's default clock: production wiring may omit now, so flush()
// must not throw when it falls back to Date.now.
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

test("flush works without a preceding report", () => {
    const sent = [];
    const throttle = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 250, now: () => 0 });
    throttle.flush({ filesDone: 1 });
    assert.strictEqual(sent.length, 1);
});

import test from "node:test";
import assert from "node:assert";
import { initialTransferState, transferReducer } from "../transferState.js";

const run = (events, state = initialTransferState) => events.reduce(transferReducer, state);
const started = (id = "t1") => ({ type: "start", id, action: "copy", destination: "/dst", filesTotal: 2 });

test("a started transfer shows up as running", () => {
    const s = run([started()]);
    assert.strictEqual(s.transfers.length, 1);
    assert.strictEqual(s.transfers[0].id, "t1");
    assert.strictEqual(s.transfers[0].status, "running");
    assert.strictEqual(s.transfers[0].destination, "/dst");
});

test("progress updates only the transfer it names", () => {
    const s = run([started("t1"), started("t2"),
        { type: "progress", payload: { transferId: "t2", file: "b.txt", bytesDone: 5, bytesTotal: 10, filesDone: 1, filesTotal: 2 } }]);
    assert.strictEqual(s.transfers.find((t) => t.id === "t1").file, undefined);
    assert.strictEqual(s.transfers.find((t) => t.id === "t2").file, "b.txt");
    assert.strictEqual(s.transfers.find((t) => t.id === "t2").bytesDone, 5);
});

test("progress for an unknown transfer is ignored instead of creating one", () => {
    const s = run([started(), { type: "progress", payload: { transferId: "ghost", bytesDone: 1 } }]);
    assert.strictEqual(s.transfers.length, 1);
    assert.strictEqual(s.transfers[0].id, "t1");
});

test("progress for an unknown transfer returns the very same state, not just an equal one", () => {
    const before = run([started()]);
    const after = transferReducer(before, { type: "progress", payload: { transferId: "ghost", bytesDone: 1 } });
    assert.strictEqual(after, before);
});

test("a finished transfer carries its counts", () => {
    const s = run([started(), { type: "done", payload: { transferId: "t1", filesTransferred: 2, filesSkipped: 0, cancelled: false } }]);
    assert.strictEqual(s.transfers[0].status, "done");
    assert.strictEqual(s.transfers[0].filesTransferred, 2);
});

test("a cancelled transfer is distinguishable from a completed one", () => {
    const s = run([started(), { type: "done", payload: { transferId: "t1", filesTransferred: 1, filesSkipped: 0, cancelled: true } }]);
    assert.strictEqual(s.transfers[0].status, "cancelled");
});

test("an error keeps its message and names what was left behind", () => {
    const s = run([started(), { type: "error", payload: { transferId: "t1", message: "Transfer not permitted",
        leftovers: ["/dst/a.part"], sourceLeftovers: ["/src/b.txt"] } }]);
    assert.strictEqual(s.transfers[0].status, "error");
    assert.strictEqual(s.transfers[0].message, "Transfer not permitted");
    assert.deepStrictEqual(s.transfers[0].leftovers, ["/dst/a.part", "/src/b.txt"]);
});

test("a conflict is queued against its own transfer", () => {
    const s = run([started("t1"), started("t2"),
        { type: "conflict", payload: { transferId: "t2", file: "/dst/a.txt", destSize: 1, srcSize: 2 } }]);
    assert.strictEqual(s.conflicts.length, 1);
    assert.strictEqual(s.conflicts[0].transferId, "t2");
});

test("a conflict for an unknown transfer is dropped", () => {
    const s = run([started(), { type: "conflict", payload: { transferId: "ghost", file: "/x" } }]);
    assert.strictEqual(s.conflicts.length, 0);
});

test("resolving removes exactly that conflict", () => {
    const s = run([started("t1"), started("t2"),
        { type: "conflict", payload: { transferId: "t1", file: "/dst/a.txt" } },
        { type: "conflict", payload: { transferId: "t2", file: "/dst/a.txt" } },
        { type: "resolved", id: "t1", file: "/dst/a.txt" }]);
    assert.strictEqual(s.conflicts.length, 1);
    assert.strictEqual(s.conflicts[0].transferId, "t2");
});

test("resolving one file does not clear another conflict queued for the very same transfer", () => {
    const s = run([started("t1"),
        { type: "conflict", payload: { transferId: "t1", file: "/dst/a.txt" } },
        { type: "conflict", payload: { transferId: "t1", file: "/dst/b.txt" } },
        { type: "resolved", id: "t1", file: "/dst/a.txt" }]);
    assert.strictEqual(s.conflicts.length, 1);
    assert.strictEqual(s.conflicts[0].file, "/dst/b.txt");
});

test("resolving a conflict that is already gone returns the very same state", () => {
    const before = run([started("t1"),
        { type: "conflict", payload: { transferId: "t1", file: "/dst/a.txt" } },
        { type: "resolved", id: "t1", file: "/dst/a.txt" }]);
    const after = transferReducer(before, { type: "resolved", id: "t1", file: "/dst/a.txt" });
    assert.strictEqual(after, before);
});

test("finishing a transfer drops any conflict still queued for it", () => {
    const s = run([started(), { type: "conflict", payload: { transferId: "t1", file: "/dst/a.txt" } },
        { type: "done", payload: { transferId: "t1", cancelled: true } }]);
    assert.strictEqual(s.conflicts.length, 0);
});

test("an error drops a queued conflict too, so no dialog outlives its transfer", () => {
    const s = run([started(), { type: "conflict", payload: { transferId: "t1", file: "/dst/a.txt" } },
        { type: "error", payload: { transferId: "t1", message: "boom" } }]);
    assert.strictEqual(s.conflicts.length, 0);
});

test("a cancel request is visible before the server confirms", () => {
    const s = run([started(), { type: "cancelling", id: "t1" }]);
    assert.strictEqual(s.transfers[0].status, "cancelling");
});

test("a finished transfer can be dismissed, a running one cannot", () => {
    const done = run([started(), { type: "done", payload: { transferId: "t1", cancelled: false } }, { type: "dismiss", id: "t1" }]);
    assert.strictEqual(done.transfers.length, 0);
    const running = run([started(), { type: "dismiss", id: "t1" }]);
    assert.strictEqual(running.transfers.length, 1);
});

test("dismissing a running or unknown transfer returns the very same state", () => {
    const before = run([started("t1")]);
    const runningIgnored = transferReducer(before, { type: "dismiss", id: "t1" });
    assert.strictEqual(runningIgnored, before);
    const unknownIgnored = transferReducer(before, { type: "dismiss", id: "ghost" });
    assert.strictEqual(unknownIgnored, before);
});

test("losing the connection ends every unfinished transfer instead of leaving it spinning", () => {
    const s = run([started("t1"), started("t2"), { type: "cancelling", id: "t2" },
        { type: "done", payload: { transferId: "t1", cancelled: false } },
        { type: "conflict", payload: { transferId: "t2", file: "/dst/a.txt" } },
        { type: "connectionLost" }]);
    // t1 was already done and keeps its result; t2 was still in flight and must not stay stuck.
    assert.strictEqual(s.transfers.find((t) => t.id === "t1").status, "done");
    assert.strictEqual(s.transfers.find((t) => t.id === "t2").status, "error");
    assert.strictEqual(s.conflicts.length, 0);
});

test("losing the connection when everything is already finished returns the very same state", () => {
    const before = run([started("t1"), { type: "done", payload: { transferId: "t1", cancelled: false } }]);
    const after = transferReducer(before, { type: "connectionLost" });
    assert.strictEqual(after, before);
});

test("an unknown event leaves the state untouched and identical", () => {
    const before = run([started()]);
    assert.strictEqual(transferReducer(before, { type: "nonsense" }), before);
});

test("a malformed leftovers field on an error does not crash the reducer", () => {
    const before = run([started()]);
    assert.doesNotThrow(() => transferReducer(before,
        { type: "error", payload: { transferId: "t1", message: "boom", leftovers: 5, sourceLeftovers: {} } }));
});

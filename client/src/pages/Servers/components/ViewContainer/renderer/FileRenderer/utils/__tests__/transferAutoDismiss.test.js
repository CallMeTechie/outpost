import test from "node:test";
import assert from "node:assert";
import { AUTO_DISMISS_DELAY_MS, shouldAutoDismiss } from "../transferAutoDismiss.js";

test("a cleanly finished transfer is eligible to auto-dismiss", () => {
    assert.strictEqual(shouldAutoDismiss({ status: "done" }), true);
    assert.strictEqual(shouldAutoDismiss({ status: "done", filesSkipped: 0 }), true);
});

test("a cancelled transfer stays, even without a filesSkipped or leftovers field", () => {
    assert.strictEqual(shouldAutoDismiss({ status: "cancelled" }), false);
});

test("an error stays, even without a filesSkipped or leftovers field", () => {
    assert.strictEqual(shouldAutoDismiss({ status: "error" }), false);
});

test("a transfer still in flight is never eligible", () => {
    assert.strictEqual(shouldAutoDismiss({ status: "running" }), false);
    assert.strictEqual(shouldAutoDismiss({ status: "cancelling" }), false);
});

// TransferList.jsx renders these as their own lines — auto-dismissing would clear a message
// before it was read.
test("a done transfer that skipped files stays", () => {
    assert.strictEqual(shouldAutoDismiss({ status: "done", filesSkipped: 3 }), false);
});

test("a done transfer with leftovers stays", () => {
    assert.strictEqual(shouldAutoDismiss({ status: "done", leftovers: ["/dst/a.part"] }), false);
});

test("a done transfer with both skipped files and leftovers stays", () => {
    assert.strictEqual(shouldAutoDismiss({ status: "done", filesSkipped: 1, leftovers: ["/dst/a.part"] }), false);
});

// The reducer turns an empty leftovers array into undefined on "done", but the guard is written
// to hold even if a caller passes one through directly.
test("an empty leftovers array does not block auto-dismiss", () => {
    assert.strictEqual(shouldAutoDismiss({ status: "done", leftovers: [] }), true);
});

test("the auto-dismiss delay is three seconds", () => {
    assert.strictEqual(AUTO_DISMISS_DELAY_MS, 3000);
});

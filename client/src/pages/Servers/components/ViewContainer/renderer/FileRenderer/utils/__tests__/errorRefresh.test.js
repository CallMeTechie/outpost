import test from "node:test";
import assert from "node:assert";
import { createErrorRefreshGate } from "../errorRefresh.js";

test("a pane that never listed anything does not reload on an error", () => {
    const gate = createErrorRefreshGate();
    assert.strictEqual(gate.errorArrived(), false);
    assert.strictEqual(gate.errorArrived(), false);
    assert.strictEqual(gate.errorArrived(), false);
});

test("after a listing succeeded, the first error reloads and the second does not", () => {
    const gate = createErrorRefreshGate();
    gate.listingSucceeded();
    assert.strictEqual(gate.errorArrived(), true);
    assert.strictEqual(gate.errorArrived(), false);
});

test("a successful listing arms the gate again", () => {
    const gate = createErrorRefreshGate();
    gate.listingSucceeded();
    assert.strictEqual(gate.errorArrived(), true);
    gate.listingSucceeded();
    assert.strictEqual(gate.errorArrived(), true);
});

// Der Lizenzfall: das allererste Auflisten scheitert. Genau eine Anfrage, genau ein Hinweis.
test("an account whose very first listing fails asks exactly once", () => {
    const gate = createErrorRefreshGate();
    let requests = 1;                       // die Auflistung, die READY ausgelöst hat
    for (let i = 0; i < 5; i++) if (gate.errorArrived()) requests++;
    assert.strictEqual(requests, 1);
});

test("repeated successes without errors change nothing", () => {
    const gate = createErrorRefreshGate();
    gate.listingSucceeded();
    gate.listingSucceeded();
    assert.strictEqual(gate.errorArrived(), true);
    assert.strictEqual(gate.errorArrived(), false);
});

// Wovon abhängt, ob ein Fehler als leerer Ordner oder als Fehler aussieht.
test("hasListed reports whether this pane ever saw a listing", () => {
    const gate = createErrorRefreshGate();
    assert.strictEqual(gate.hasListed(), false);
    gate.errorArrived();
    assert.strictEqual(gate.hasListed(), false);
    gate.listingSucceeded();
    assert.strictEqual(gate.hasListed(), true);
    gate.errorArrived();
    assert.strictEqual(gate.hasListed(), true);
});

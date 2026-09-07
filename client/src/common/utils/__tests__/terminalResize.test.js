import test from "node:test";
import assert from "node:assert/strict";
import { shouldFit, shouldSendSize } from "../terminalResize.js";

test("fit only when the measured size differs from what is rendered", () => {
    assert.equal(shouldFit({ cols: 145, rows: 53 }, { cols: 80, rows: 24 }), true);
    assert.equal(shouldFit({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }), false);
    assert.equal(shouldFit({ cols: 80, rows: 53 }, { cols: 80, rows: 24 }), true);
});

test("no fit on a measurement that says nothing", () => {
    // proposeDimensions returns undefined while the renderer has no cell size yet.
    assert.equal(shouldFit(undefined, { cols: 80, rows: 24 }), false);
    assert.equal(shouldFit({ cols: 0, rows: 0 }, { cols: 80, rows: 24 }), false);
});

test("a size the host has not been told is sent", () => {
    assert.equal(shouldSendSize({ cols: 145, rows: 53 }, null, true), true);
    assert.equal(shouldSendSize({ cols: 145, rows: 53 }, { cols: 80, rows: 24 }, true), true);
});

test("a size the host already has is not sent again", () => {
    // The whole point of tracking it: the 300 ms poll must not turn into a stream.
    assert.equal(shouldSendSize({ cols: 145, rows: 53 }, { cols: 145, rows: 53 }, true), false);
});

test("nothing is sent through a socket that is not open", () => {
    // The case that broke: skipped here, and the next poll must try again -- which it does,
    // because lastSent is still null.
    assert.equal(shouldSendSize({ cols: 145, rows: 53 }, null, false), false);
    assert.equal(shouldSendSize({ cols: 145, rows: 53 }, { cols: 80, rows: 24 }, false), false);
});

test("a size that measures to nothing is never sent", () => {
    assert.equal(shouldSendSize(undefined, null, true), false);
    assert.equal(shouldSendSize({ cols: 0, rows: 0 }, null, true), false);
});

// --- Zwei-Takt-Bremse ---------------------------------------------------------------------

test("ein Vorschlag zurück auf die eben verlassene Größe wird kurz abgelehnt", () => {
    // Der gemessene Fall: konstante Breite, Vorschlag kippt zwischen 104 und 105.
    const current = { cols: 104, rows: 57 };
    const previous = { cols: 105, rows: 57, at: 1000 };
    assert.equal(shouldFit({ cols: 105, rows: 57 }, current, previous, 1300), false);
});

test("nach Ablauf der Sperre kommt derselbe Vorschlag durch", () => {
    // Sonst bliebe ein Terminal für immer auf einer Größe stehen, die der Nutzer verlassen hat.
    const current = { cols: 104, rows: 57 };
    const previous = { cols: 105, rows: 57, at: 1000 };
    assert.equal(shouldFit({ cols: 105, rows: 57 }, current, previous, 4000), true);
});

test("ein echter Größenwechsel kommt sofort durch", () => {
    const current = { cols: 104, rows: 57 };
    const previous = { cols: 105, rows: 57, at: 1000 };
    assert.equal(shouldFit({ cols: 130, rows: 57 }, current, previous, 1100), true);
    assert.equal(shouldFit({ cols: 105, rows: 40 }, current, previous, 1100), true);
});

test("ohne Vorgeschichte bleibt es beim einfachen Vergleich", () => {
    assert.equal(shouldFit({ cols: 145, rows: 53 }, { cols: 80, rows: 24 }), true);
    assert.equal(shouldFit({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }), false);
});

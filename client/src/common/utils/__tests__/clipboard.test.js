import test from "node:test";
import assert from "node:assert/strict";
import { copyToClipboard } from "../clipboard.js";

// A DOM small enough for what the fallback touches: create a textarea, append it, select it,
// execCommand, remove it. node:test has no DOM, so the few pieces are stubbed here.
const withDom = async (options, run) => {
    const removed = [];
    const appended = [];
    const created = [];
    globalThis.document = {
        createElement: () => {
            const el = { style: {}, value: "", attributes: {},
                setAttribute(k, v) { this.attributes[k] = v; },
                select() { if (options.selectThrows) throw new Error("cannot select"); this.selected = true; } };
            created.push(el);
            return el;
        },
        body: {
            appendChild: (el) => appended.push(el),
            removeChild: (el) => removed.push(el),
        },
        execCommand: () => {
            if (options.execThrows) throw new Error("blocked");
            return options.execResult ?? true;
        },
    };
    // node exposes navigator as a getter-only global, so it cannot simply be assigned.
    Object.defineProperty(globalThis, "navigator", { value: options.navigator ?? {}, configurable: true });
    try {
        return { result: await run(), created, appended, removed };
    } finally {
        delete globalThis.document;
        delete globalThis.navigator;
        Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
    }
};

test("uses the Clipboard API when it is there", async () => {
    let written = null;
    const { result } = await withDom(
        { navigator: { clipboard: { writeText: async (t) => { written = t; } } } },
        () => copyToClipboard("/var/log/syslog"));
    assert.equal(result, true);
    assert.equal(written, "/var/log/syslog");
});

test("falls back when navigator.clipboard is absent, without throwing", async () => {
    // The whole reason this module exists: on plain http the API is undefined, and
    // navigator.clipboard.writeText(...) throws synchronously rather than rejecting.
    const { result, created } = await withDom({ navigator: {} }, () => copyToClipboard("/etc/hosts"));
    assert.equal(result, true);
    assert.equal(created[0].value, "/etc/hosts");
});

test("falls back when navigator exists but has no clipboard property at all", async () => {
    const { result } = await withDom({ navigator: { userAgent: "x" } }, () => copyToClipboard("/tmp/a"));
    assert.equal(result, true);
});

test("falls back when the Clipboard API rejects", async () => {
    const { result, created } = await withDom(
        { navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } } },
        () => copyToClipboard("/srv/data"));
    assert.equal(result, true);
    assert.equal(created[0].value, "/srv/data");
});

test("reports failure rather than claiming success", async () => {
    const { result } = await withDom({ navigator: {}, execResult: false }, () => copyToClipboard("/x"));
    assert.equal(result, false);
});

test("survives execCommand throwing", async () => {
    const { result } = await withDom({ navigator: {}, execThrows: true }, () => copyToClipboard("/x"));
    assert.equal(result, false);
});

test("always removes the textarea, even when selecting throws", async () => {
    // Left behind, it would sit in the DOM forever and could steal focus.
    const { result, appended, removed } = await withDom(
        { navigator: {}, selectThrows: true }, () => copyToClipboard("/x"));
    assert.equal(result, false);
    assert.equal(appended.length, 1);
    assert.equal(removed.length, 1);
    assert.equal(appended[0], removed[0]);
});

test("refuses empty and non-string input without touching the DOM", async () => {
    for (const value of ["", null, undefined, 42, {}]) {
        const { result, appended } = await withDom({ navigator: {} }, () => copyToClipboard(value));
        assert.equal(result, false, String(value));
        assert.equal(appended.length, 0, String(value));
    }
});

import test from "node:test";
import assert from "node:assert";
import { resolveDropTarget, resolveDropOutcome, DRAG_PROVIDER, DROP_ASK, DROP_DONE, DROP_FAILED }
    from "../dropTransfer.js";

const drag = (over = {}) => ({
    paths: ["/src/a.txt"], items: [{ name: "a.txt" }], sessionId: "s-src", provider: DRAG_PROVIDER, ...over,
});
// `data` wird zuletzt gesetzt, damit ein Teil-Payload den zusammengebauten nicht ersetzt.
const call = ({ data, ...rest } = {}) => resolveDropTarget({
    sessionId: "s-dst", destination: "/dst", ...rest, data: drag(data),
});

test("a drop from another session becomes a transfer", () => {
    const r = call();
    assert.strictEqual(r.kind, "transfer");
    assert.strictEqual(r.sourceSessionId, "s-src");
    assert.strictEqual(r.provider, DRAG_PROVIDER);
    assert.deepStrictEqual(r.paths, ["/src/a.txt"]);
    assert.strictEqual(r.destination, "/dst");
});

test("a drop from the same session stays on the existing path", () => {
    const r = call({ sessionId: "s-src" });
    assert.strictEqual(r.kind, "local");
    assert.strictEqual(r.sourceSessionId, undefined);
});

test("an unknown provider is refused", () => {
    assert.strictEqual(call({ data: { provider: "onedrive" } }).kind, "reject");
});

test("a payload without a provider is refused, so an older pane cannot half-understand it", () => {
    assert.strictEqual(call({ data: { provider: undefined } }).kind, "reject");
});

test("a payload without paths is refused", () => {
    assert.strictEqual(call({ data: { paths: [] } }).kind, "reject");
});

test("a payload without a session id is refused", () => {
    assert.strictEqual(call({ data: { sessionId: undefined } }).kind, "reject");
});

test("dropping a folder onto itself is refused", () => {
    const r = call({ data: { sessionId: "s-dst", items: [{ name: "target" }] }, excludeName: "target" });
    assert.strictEqual(r.kind, "reject");
});

test("the self-drop guard also holds across sessions", () => {
    const r = call({ data: { items: [{ name: "target" }] }, excludeName: "target" });
    assert.strictEqual(r.kind, "reject");
});

test("a local drop into the directory the files already sit in is refused", () => {
    const r = call({ data: { sessionId: "s-dst", paths: ["/dst/a.txt"] }, destination: "/dst", currentPath: "/dst" });
    assert.strictEqual(r.kind, "reject");
});

test("a trailing slash on the current path does not defeat that check", () => {
    const r = call({ data: { sessionId: "s-dst", paths: ["/dst/a.txt"] }, destination: "/dst/", currentPath: "/dst/" });
    assert.strictEqual(r.kind, "reject");
});

test("the same paths from another session are NOT redundant - it is a different host", () => {
    const r = call({ data: { paths: ["/dst/a.txt"] }, destination: "/dst", currentPath: "/dst" });
    assert.strictEqual(r.kind, "transfer");
});

test("a mixed local drop is allowed as soon as one path comes from elsewhere", () => {
    const r = call({ data: { sessionId: "s-dst", paths: ["/dst/a.txt", "/other/b.txt"] }, destination: "/dst", currentPath: "/dst" });
    assert.strictEqual(r.kind, "local");
});

test("a malformed payload is refused instead of throwing", () => {
    for (const data of [null, undefined, {}, [], "x", 7]) {
        assert.strictEqual(resolveDropTarget({ data, sessionId: "s-dst", destination: "/dst" }).kind, "reject");
    }
});

// Finding 1: a non-string entry in `paths` used to reach `parentOf`, which calls `.substring`/
// `.lastIndexOf` on it and throws for anything that is not a string.
test("a null entry in paths is refused during the redundancy check, not thrown at", () => {
    const r = call({ data: { sessionId: "s-dst", paths: ["/dst/a.txt", null] }, destination: "/dst", currentPath: "/dst" });
    assert.strictEqual(r.kind, "reject");
});

test("a numeric entry in paths is refused during the redundancy check, not thrown at", () => {
    const r = call({ data: { sessionId: "s-dst", paths: ["/dst/a.txt", 42] }, destination: "/dst", currentPath: "/dst" });
    assert.strictEqual(r.kind, "reject");
});

// Finding 2: `data.items?.some(...)` only guards against null/undefined `items`, not against a
// wrong type such as a string or plain object, which do not have `.some` and throw.
test("an items value that is neither absent nor an array is refused, not thrown at", () => {
    const r = call({ data: { items: "not-an-array" }, excludeName: "target" });
    assert.strictEqual(r.kind, "reject");
});

// Finding 3: a cross-session drop skipped the redundancy check entirely, so malformed path
// entries were waved through as a "transfer" instead of being caught before the server sees them.
test("a cross-session drop with malformed path entries is refused, not sent on to the server", () => {
    const r = call({ data: { paths: ["/src/a.txt", null, 42] } });
    assert.strictEqual(r.kind, "reject");
});

// Finding 4: `!data.sessionId` only rejects falsy values; a number or other truthy non-string
// slipped through as a session id.
test("a session id that is not a string is refused", () => {
    const r = call({ data: { sessionId: 123 } });
    assert.strictEqual(r.kind, "reject");
});

test("no malicious payload ever throws, and every result is one of the three known kinds", () => {
    const malformedOverrides = [
        { paths: ["/dst/a.txt", null] },
        { paths: ["/dst/a.txt", 42] },
        { paths: [""] },
        { paths: [null] },
        { items: "nope" },
        { items: 7 },
        { items: true },
        { items: {} },
        { sessionId: 123 },
        { sessionId: {} },
        { sessionId: true },
        { sessionId: "" },
    ];
    const KNOWN_KINDS = ["reject", "local", "transfer"];

    for (const data of malformedOverrides) {
        // Same-session drops exercise the redundancy check (which calls parentOf on every path);
        // cross-session drops exercise the transfer branch instead. A malformed payload has to
        // survive both. Skip the axis when the override pins its own sessionId - that IS the
        // case under test then.
        const sessionIdVariants = "sessionId" in data ? [data.sessionId] : ["s-src", "s-dst"];

        for (const sid of sessionIdVariants) {
            for (const excludeName of [undefined, "target"]) {
                for (const currentPath of [undefined, "/dst"]) {
                    let result;
                    assert.doesNotThrow(() => {
                        result = call({ data: { ...data, sessionId: sid }, excludeName, currentPath });
                    });
                    assert.ok(KNOWN_KINDS.includes(result.kind), `unexpected kind: ${result.kind}`);
                }
            }
        }
    }
});

// The three outcomes a drop site acts on. Inside the hook they were string literals no test could
// reach, so the difference between "nothing happened" and "it worked" cost nothing to lose.
test("a preference that asks the user does not carry the drop out", () => {
    let calls = 0;
    const outcome = resolveDropOutcome("ask", () => { calls += 1; return true; });
    assert.strictEqual(outcome, DROP_ASK);
    assert.strictEqual(calls, 0, "the menu has not been answered yet - nothing may move");
});

test("an action nobody chose asks rather than guessing", () => {
    assert.strictEqual(resolveDropOutcome(undefined, () => true), DROP_ASK);
    assert.strictEqual(resolveDropOutcome("", () => true), DROP_ASK);
});

test("a handed-over drop is done, and the handler runs exactly once", () => {
    for (const action of ["move", "copy"]) {
        let calls = 0;
        const outcome = resolveDropOutcome(action, () => { calls += 1; return "transfer-id"; });
        assert.strictEqual(outcome, DROP_DONE);
        assert.strictEqual(calls, 1);
    }
});

// The case the caller must tell apart from "ask": nothing went out, so the selection stays and no
// menu opens.
test("a drop the handler refused is failed, not done and not a question", () => {
    for (const refusal of [false, null, undefined, 0, ""]) {
        assert.strictEqual(resolveDropOutcome("move", () => refusal), DROP_FAILED);
        assert.strictEqual(resolveDropOutcome("copy", () => refusal), DROP_FAILED);
    }
});

test("the three outcomes stay distinguishable from one another", () => {
    assert.strictEqual(new Set([DROP_ASK, DROP_DONE, DROP_FAILED]).size, 3);
});

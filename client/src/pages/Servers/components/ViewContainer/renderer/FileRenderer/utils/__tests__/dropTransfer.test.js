import test from "node:test";
import assert from "node:assert";
import { resolveDropTarget, DRAG_PROVIDER } from "../dropTransfer.js";

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

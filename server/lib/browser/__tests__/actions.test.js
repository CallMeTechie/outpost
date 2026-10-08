const test = require("node:test");
const assert = require("node:assert");
const { click, typeText, selectOption } = require("../actions");
const { BrowserErrorCode } = require("../errors");

const recorder = (responses = {}) => {
    const calls = [];
    const send = async (method, params = {}) => {
        calls.push({ method, params });
        const response = responses[method];
        return typeof response === "function" ? response(params) : (response ?? {});
    };
    return { send, calls };
};

const viewport = { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } };
const square = (x, y, size) => [x, y, x + size, y, x + size, y + size, x, y + size];

test("a click scrolls first, then presses at the centre of the visible quad", async () => {
    const { send, calls } = recorder({ "DOM.getContentQuads": { quads: [square(100, 200, 40)] }, "Page.getLayoutMetrics": viewport });
    assert.deepStrictEqual(await click(send, 42, { clickCount: 2 }), { x: 120, y: 220 });
    assert.deepStrictEqual(calls.map((c) => c.method).slice(0, 3), ["DOM.scrollIntoViewIfNeeded", "DOM.getContentQuads", "Page.getLayoutMetrics"]);
    assert.deepStrictEqual(calls[0].params, { backendNodeId: 42 });
    const mouse = calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => [c.params.type, c.params.x, c.params.y, c.params.clickCount ?? 0]);
    assert.deepStrictEqual(mouse, [
        ["mouseMoved", 120, 220, 0],
        ["mousePressed", 120, 220, 1], ["mouseReleased", 120, 220, 1],
        ["mousePressed", 120, 220, 2], ["mouseReleased", 120, 220, 2],
    ]);
});

test("an element without a visible box is refused and no mouse event is sent", async () => {
    for (const quads of [[], [square(10, 10, 0)], [square(2000, 10, 20)]]) {
        const { send, calls } = recorder({ "DOM.getContentQuads": { quads }, "Page.getLayoutMetrics": viewport });
        await assert.rejects(click(send, 7), (err) => err.code === BrowserErrorCode.NOT_VISIBLE);
        assert.strictEqual(calls.filter((c) => c.method === "Input.dispatchMouseEvent").length, 0);
    }
});

test("typing replaces the value, passes newline and emoji through untouched, and submits with a real Enter", async () => {
    const { send, calls } = recorder({ "DOM.getContentQuads": { quads: [square(0, 0, 20)] }, "Page.getLayoutMetrics": viewport });
    await typeText(send, 5, "line one\nzwei 😀", { submit: true });
    const keys = calls.filter((c) => c.method === "Input.dispatchKeyEvent").map((c) => c.params);
    assert.deepStrictEqual(keys[0], { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
    assert.strictEqual(keys[1].type, "keyUp");
    const insert = calls.findIndex((c) => c.method === "Input.insertText");
    assert.deepStrictEqual(calls[insert].params, { text: "line one\nzwei 😀" });
    assert.deepStrictEqual(keys.slice(2).map((k) => [k.type, k.key, k.text]), [["keyDown", "Enter", "\r"], ["keyUp", "Enter", undefined]]);
    assert.ok(calls.findIndex((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed") < insert, "focus by a real click first");
});

test("choosing a select option focuses without a click and moves with real arrow keys from the selected one", async () => {
    const { send, calls } = recorder();
    const options = [{ name: "A", selected: false }, { name: "B", selected: true }, { name: "C", selected: false }, { name: "D", selected: false }];
    await selectOption(send, 9, options, "D");
    assert.deepStrictEqual(calls[0], { method: "DOM.focus", params: { backendNodeId: 9 } });
    assert.strictEqual(calls.filter((c) => c.method === "Input.dispatchMouseEvent").length, 0);
    assert.deepStrictEqual(calls.filter((c) => c.params.type === "rawKeyDown").map((c) => c.params.key), ["ArrowDown", "ArrowDown"]);
    await assert.rejects(selectOption(send, 9, options, "Z"), (err) => err.code === BrowserErrorCode.INVALID_ARGUMENT && /"A", "B", "C", "D"/.test(err.message));
});

import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { Buffer } from "node:buffer";
import { mousePayload, keyPayload, pastePayload, resizePayload, wheelPayload, imePayloads, touchScrollPayload, IME_FILLER } from "../inputPayload.js";
import { decodeFrame, isNewerSeq } from "../frameProtocol.js";

// The other side of the seam is the server's own code, not a copy of it.
const require = createRequire(import.meta.url);
const { toCdpCalls } = require("../../../../../../../../../server/lib/browser/input.js");
const { encodeFrame } = require("../../../../../../../../../server/lib/browser/frameProtocol.js");

const noKeys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const viewport = { width: 1600, height: 1000 };

test("a click lands on the same page pixel with the same button and modifier bits, scaled or letterboxed", () => {
    const scaled = { left: 100, top: 50, width: 800, height: 500 };
    const down = { ...noKeys, clientX: 500, clientY: 300, button: 0, buttons: 1, detail: 2, ctrlKey: true, shiftKey: true };
    assert.deepStrictEqual(toCdpCalls(mousePayload("down", down, scaled, viewport)), [{
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: 800, y: 500, button: "left", clickCount: 2, modifiers: 10 },
    }]);

    const letterboxed = { left: 0, top: 0, width: 800, height: 800 };
    const corner = { ...noKeys, clientX: 0, clientY: 150, button: 2, buttons: 2, detail: 1, altKey: true, metaKey: true };
    const [{ params }] = toCdpCalls(mousePayload("up", corner, letterboxed, viewport));
    assert.deepStrictEqual(params, { type: "mouseReleased", x: 0, y: 0, button: "right", clickCount: 1, modifiers: 5 });

    const [{ params: drag }] = toCdpCalls(mousePayload("move", { ...noKeys, clientX: 300, clientY: 175, buttons: 1 }, scaled, viewport));
    assert.deepStrictEqual(drag, { type: "mouseMoved", x: 400, y: 250, button: "left", modifiers: 0 });
});

test("a key arrives with the same key, code, virtual key code, text and modifiers; shortcuts insert no text; pasted text arrives verbatim", () => {
    const shiftA = { ...noKeys, key: "A", code: "KeyA", keyCode: 65, shiftKey: true };
    assert.deepStrictEqual(toCdpCalls(keyPayload("down", shiftA))[0].params, { type: "keyDown", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 8, text: "A" });
    assert.deepStrictEqual(toCdpCalls(keyPayload("down", { ...noKeys, key: "Enter", code: "Enter", keyCode: 13 }))[0].params.text, "\r");

    const copy = toCdpCalls(keyPayload("down", { ...noKeys, key: "c", code: "KeyC", keyCode: 67, ctrlKey: true }))[0].params;
    assert.deepStrictEqual([copy.type, copy.text, copy.modifiers], ["rawKeyDown", undefined, 2]);
    assert.strictEqual(toCdpCalls(keyPayload("up", shiftA))[0].params.type, "keyUp");

    const altGrQ = { ...noKeys, key: "@", code: "KeyQ", keyCode: 81, ctrlKey: true, altKey: true };
    const typed = toCdpCalls(keyPayload("down", altGrQ))[0].params;
    assert.deepStrictEqual([typed.type, typed.text, typed.modifiers], ["keyDown", "@", 0]);
    const shortcut = toCdpCalls(keyPayload("down", { ...noKeys, key: "t", code: "KeyT", keyCode: 84, ctrlKey: true, altKey: true }))[0].params;
    assert.deepStrictEqual([shortcut.type, shortcut.text, shortcut.modifiers], ["rawKeyDown", undefined, 3]);

    assert.deepStrictEqual(toCdpCalls(pastePayload("pw 😀\nx")), [{ method: "Input.insertText", params: { text: "pw 😀\nx" } }]);
});

test("wheel lines become pixels, and the canvas size becomes the page's device metrics", () => {
    const rect = { left: 0, top: 0, width: 800, height: 500 };
    const [{ params: wheel }] = toCdpCalls(wheelPayload({ ...noKeys, clientX: 400, clientY: 250, deltaX: 0, deltaY: 3, deltaMode: 1 }, rect, viewport));
    assert.deepStrictEqual(wheel, { type: "mouseWheel", x: 800, y: 500, deltaX: 0, deltaY: 120, modifiers: 0 });

    const [metrics, , screencast] = toCdpCalls(resizePayload({ width: 1234.6, height: 777.2 }));
    assert.deepStrictEqual(metrics.params, { width: 1235, height: 777, deviceScaleFactor: 1, mobile: false });
    assert.deepStrictEqual([screencast.params.maxWidth, screencast.params.maxHeight], [1235, 777]);
});

test("a frame packed by the server unpacks in the client, and ordering survives the 2^32 wrap", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    const packed = encodeFrame(0xffffffff, jpeg);
    const asReceived = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
    const frame = decodeFrame(asReceived);
    assert.strictEqual(frame.seq, 0xffffffff);
    assert.deepStrictEqual([...frame.data], [...jpeg]);

    assert.strictEqual(isNewerSeq(0, 0xffffffff), true, "the first frame after the wrap is newer");
    assert.strictEqual(isNewerSeq(0xffffffff, 0), false);
    assert.strictEqual(isNewerSeq(5, 9), false);
    assert.strictEqual(isNewerSeq(7, null), true);
    assert.strictEqual(decodeFrame(new ArrayBuffer(3)), null);
});

test("what a soft keyboard leaves in the hidden field arrives as typed text, Enter and Backspace", () => {
    const calls = (value) => imePayloads(value).flatMap(toCdpCalls).map(({ method, params }) =>
        method === "Input.insertText" ? params.text : `${params.type}:${params.key}${params.text ? `(${JSON.stringify(params.text)})` : ""}`);
    assert.deepStrictEqual(calls(IME_FILLER), []);
    assert.deepStrictEqual(calls(`${IME_FILLER}Grüße 😀`), ["Grüße 😀"]);
    assert.deepStrictEqual(calls(`${IME_FILLER}ab\ncd`), ["ab", "keyDown:Enter(\"\\r\")", "keyUp:Enter", "cd"]);
    assert.deepStrictEqual(calls(IME_FILLER.slice(1)), ["rawKeyDown:Backspace", "keyUp:Backspace"]);
    assert.deepStrictEqual(calls(""), ["rawKeyDown:Backspace", "keyUp:Backspace", "rawKeyDown:Backspace", "keyUp:Backspace"]);
});

test("a finger drag scrolls the page by the dragged distance in page pixels, content following the finger", () => {
    const rect = { left: 0, top: 0, width: 800, height: 500 };
    const [{ params }] = toCdpCalls(touchScrollPayload({ clientX: 400, clientY: 300 }, { clientX: 390, clientY: 200 }, rect, viewport));
    assert.deepStrictEqual(params, { type: "mouseWheel", x: 780, y: 400, deltaX: 20, deltaY: 200, modifiers: 0 });
});

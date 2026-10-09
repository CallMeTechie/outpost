export const MOVE_INTERVAL_MS = 1000 / 30;
const BUTTON_NAMES = ["left", "middle", "right", "back", "forward"];
const LINE_HEIGHT_PX = 40;

export const modifiersOf = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

// Frames are drawn "contain"-fitted into the canvas, so a pointer maps back through the same fit.
export const fitFrame = (rect, viewport) => {
    const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
    return { scale, offsetX: (rect.width - viewport.width * scale) / 2, offsetY: (rect.height - viewport.height * scale) / 2 };
};

export const toPagePoint = (e, rect, viewport) => {
    const { scale, offsetX, offsetY } = fitFrame(rect, viewport);
    const clamp = (value, size) => Math.min(Math.max(Math.round(value), 0), size - 1);
    return {
        x: clamp((e.clientX - rect.left - offsetX) / scale, viewport.width),
        y: clamp((e.clientY - rect.top - offsetY) / scale, viewport.height),
    };
};

const heldButton = (buttons) => ((buttons & 1) ? "left" : (buttons & 4) ? "middle" : (buttons & 2) ? "right" : "none");

export const mousePayload = (action, e, rect, viewport) => ({
    type: "mouse",
    action,
    ...toPagePoint(e, rect, viewport),
    button: action === "move" ? heldButton(e.buttons) : (BUTTON_NAMES[e.button] ?? "none"),
    clickCount: action === "move" ? 0 : Math.max(1, e.detail || 1),
    deltaX: 0,
    deltaY: 0,
    modifiers: modifiersOf(e),
});

export const wheelPayload = (e, rect, viewport) => {
    const unit = e.deltaMode === 1 ? LINE_HEIGHT_PX : e.deltaMode === 2 ? viewport.height : 1;
    return {
        type: "mouse", action: "wheel", ...toPagePoint(e, rect, viewport), button: "none", clickCount: 0,
        deltaX: e.deltaX * unit, deltaY: e.deltaY * unit, modifiers: modifiersOf(e),
    };
};

const baseCharacter = (code) => /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : null;

export const keyPayload = (action, e) => {
    // Windows reports AltGr as Ctrl+Alt; only a character other than the key's own makes it AltGr text.
    const altGr = Boolean(e.getModifierState?.("AltGraph")) || (e.ctrlKey && e.altKey && e.key.toLowerCase() !== baseCharacter(e.code));
    const printable = [...e.key].length === 1 && (altGr || (!e.ctrlKey && !e.metaKey));
    const text = action !== "down" ? "" : printable ? e.key : e.key === "Enter" ? "\r" : "";
    const modifiers = altGr && printable ? modifiersOf(e) & ~3 : modifiersOf(e);
    return { type: "key", action, key: e.key, code: e.code, keyCode: e.keyCode, text, modifiers };
};

// A finger drag moves the page the way the finger moves: content follows it, as in a native scroll.
export const touchScrollPayload = (from, to, rect, viewport) => {
    const { scale } = fitFrame(rect, viewport);
    return {
        type: "mouse", action: "wheel", ...toPagePoint(to, rect, viewport), button: "none", clickCount: 0,
        deltaX: (from.clientX - to.clientX) / scale, deltaY: (from.clientY - to.clientY) / scale, modifiers: 0,
    };
};

// The on-screen keyboard types into a hidden field. It starts with this filler so that Backspace
// still changes something when nothing was typed yet; many soft keyboards send no key event for it.
export const IME_FILLER = "  ";

const pressKey = (key, code, keyCode) => [
    { type: "key", action: "down", key, code, keyCode, text: key === "Enter" ? "\r" : "", modifiers: 0 },
    { type: "key", action: "up", key, code, keyCode, text: "", modifiers: 0 },
];

// What the soft keyboard did to the hidden field since it last held only the filler.
export const imePayloads = (value) => {
    let kept = 0;
    while (kept < IME_FILLER.length && value[kept] === IME_FILLER[kept]) kept++;
    const payloads = [];
    for (let i = kept; i < IME_FILLER.length; i++) payloads.push(...pressKey("Backspace", "Backspace", 8));
    value.slice(kept).split(/\r?\n/).forEach((line, index) => {
        if (index > 0) payloads.push(...pressKey("Enter", "Enter", 13));
        if (line) payloads.push(pastePayload(line));
    });
    return payloads;
};

export const resizePayload = (rect) => ({ type: "resize", width: Math.round(rect.width), height: Math.round(rect.height) });

export const pastePayload = (text) => ({ type: "paste", text });

export const createMoveThrottle = (intervalMs = MOVE_INTERVAL_MS, now = () => performance.now()) => {
    let last = -Infinity;
    return () => {
        const current = now();
        if (current - last < intervalMs) return false;
        last = current;
        return true;
    };
};

const { BrowserError, BrowserErrorCode } = require("./errors");

const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEYS = {
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    Space: { code: "Space", keyCode: 32, text: " ", key: " " },
};
// US layout. Using the character code instead sends "." as 46 (Delete) and "-" as 45 (Insert).
const PUNCTUATION_KEY_CODES = {
    ";": 186, "=": 187, ",": 188, "-": 189, ".": 190, "/": 191, "`": 192, "[": 219, "\\": 220, "]": 221, "'": 222, " ": 32,
};
const GONE = /No node (found|with given id)|detached from document/i;

const centerOf = (q) => ({ x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 });

const areaOf = (q) => {
    let area = 0;
    for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        area += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1];
    }
    return Math.abs(area / 2);
};

const unlessGone = (fallback) => (err) => {
    if (err instanceof BrowserError) throw err;
    if (GONE.test(err?.message ?? "")) throw new BrowserError(BrowserErrorCode.STALE_REF, "The element no longer exists; take a new snapshot");
    return fallback;
};

const clickablePoint = async (send, backendNodeId) => {
    await send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(unlessGone());
    const { quads } = await send("DOM.getContentQuads", { backendNodeId }).catch(unlessGone({ quads: [] }));
    const { cssLayoutViewport: viewport } = await send("Page.getLayoutMetrics");
    for (const quad of quads ?? []) {
        if (areaOf(quad) < 1) continue;
        const { x, y } = centerOf(quad);
        if (x >= 0 && y >= 0 && x < viewport.clientWidth && y < viewport.clientHeight) return { x, y };
    }
    throw new BrowserError(BrowserErrorCode.NOT_VISIBLE, "The element is not visible in the viewport");
};

const click = async (send, backendNodeId, { button = "left", clickCount = 1 } = {}) => {
    const { x, y } = await clickablePoint(send, backendNodeId);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    for (let count = 1; count <= clickCount; count++) {
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: count });
    }
    return { x, y };
};

const parseKey = (combo) => {
    const text = String(combo);
    const plusKey = text === "+" || text.endsWith("++");
    const cut = plusKey ? text.length - 1 : text.lastIndexOf("+") + 1;
    const name = text.slice(cut);
    const parts = cut > 0 ? text.slice(0, cut - 1).split("+") : [];
    let modifiers = 0;
    for (const part of parts) {
        if (!Object.hasOwn(MODIFIERS, part)) throw new BrowserError(BrowserErrorCode.INVALID_KEY, `Unknown modifier "${part}"; use Alt, Control, Meta or Shift`);
        modifiers |= MODIFIERS[part];
    }
    if (Object.hasOwn(KEYS, name)) return { key: KEYS[name].key ?? name, ...KEYS[name], modifiers };
    if ([...name].length === 1) {
        const upper = name.toUpperCase();
        const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(name) ? `Digit${name}` : "";
        const keyCode = /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : Object.hasOwn(PUNCTUATION_KEY_CODES, name) ? PUNCTUATION_KEY_CODES[name] : 0;
        return { key: name, code, keyCode, text: name, modifiers };
    }
    throw new BrowserError(BrowserErrorCode.INVALID_KEY, `Unknown key "${name}"`);
};

const pressKey = async (send, combo) => {
    const { key, code, keyCode, text, modifiers } = parseKey(combo);
    const base = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
    const typed = modifiers & (MODIFIERS.Control | MODIFIERS.Meta) ? undefined : text;
    await send("Input.dispatchKeyEvent", typed ? { type: "keyDown", ...base, text: typed } : { type: "rawKeyDown", ...base });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
};

const typeText = async (send, backendNodeId, text, { submit = false } = {}) => {
    await click(send, backendNodeId);
    // "commands" makes select-all work regardless of the platform's shortcut mapping.
    const selectAll = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: MODIFIERS.Control };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...selectAll, commands: ["selectAll"] });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...selectAll });
    await send("Input.insertText", { text: String(text) });
    if (submit) await pressKey(send, "Enter");
};

const selectOption = async (send, backendNodeId, options, wanted) => {
    const target = options.findIndex((option) => option.name === String(wanted));
    if (target === -1)
        throw new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, `No option "${wanted}"; choose one of: ${options.map((o) => JSON.stringify(o.name)).join(", ")}`);
    if (options[target].disabled) throw new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, `Option "${wanted}" is disabled`);
    const current = Math.max(options.findIndex((option) => option.selected), 0);
    // The arrow keys skip disabled options, so only the enabled ones on the way count as steps.
    const passed = target > current ? options.slice(current + 1, target + 1) : options.slice(target, current);
    const steps = passed.filter((option) => !option.disabled).length;
    // A click would open the list outside the screencast; a focused select moves with the arrow keys.
    await send("DOM.focus", { backendNodeId });
    const key = target > current ? "ArrowDown" : "ArrowUp";
    for (let step = 0; step < steps; step++) await pressKey(send, key);
};

const scroll = async (send, { backendNodeId = null, deltaY, deltaX = 0, viewport }) => {
    const point = backendNodeId !== null
        ? await clickablePoint(send, backendNodeId)
        : { x: viewport.width / 2, y: viewport.height / 2 };
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY });
};

module.exports = { clickablePoint, click, typeText, selectOption, pressKey, scroll };

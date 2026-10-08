const { BrowserError, BrowserErrorCode } = require("./errors");

const SCREENCAST = Object.freeze({ format: "jpeg", quality: 60, everyNthFrame: 1 });
const LIMITS = { minWidth: 200, maxWidth: 3840, minHeight: 200, maxHeight: 2160 };
const MOUSE_TYPES = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased", wheel: "mouseWheel" };
const BUTTONS = new Set(["none", "left", "middle", "right", "back", "forward"]);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const PASTE_LIMIT = 100000;

const clamp = (value, min, max) => Math.min(Math.max(Math.round(Number(value) || 0), min), max);
const modifiersOf = (message) => (Number.isInteger(message.modifiers) ? message.modifiers & 15 : 0);

const clampViewport = ({ width, height }) => ({
    width: clamp(width, LIMITS.minWidth, LIMITS.maxWidth),
    height: clamp(height, LIMITS.minHeight, LIMITS.maxHeight),
});

const viewportCalls = (size) => {
    const { width, height } = clampViewport(size);
    return [
        { method: "Emulation.setDeviceMetricsOverride", params: { width, height, deviceScaleFactor: 1, mobile: false } },
        { method: "Page.stopScreencast", params: {} },
        { method: "Page.startScreencast", params: { ...SCREENCAST, maxWidth: width, maxHeight: height } },
    ];
};

const mouseToCdp = (message) => {
    const type = Object.hasOwn(MOUSE_TYPES, message.action) ? MOUSE_TYPES[message.action] : undefined;
    if (!type || !Number.isFinite(message.x) || !Number.isFinite(message.y)) return [];
    const params = { type, x: message.x, y: message.y, modifiers: modifiersOf(message) };
    if (type === "mouseWheel") {
        params.deltaX = Number.isFinite(message.deltaX) ? message.deltaX : 0;
        params.deltaY = Number.isFinite(message.deltaY) ? message.deltaY : 0;
    } else {
        params.button = BUTTONS.has(message.button) ? message.button : "none";
        if (type !== "mouseMoved") params.clickCount = clamp(message.clickCount, 1, 3);
    }
    return [{ method: "Input.dispatchMouseEvent", params }];
};

const keyToCdp = (message) => {
    if ((message.action !== "down" && message.action !== "up") || typeof message.key !== "string") return [];
    const text = message.action === "down" && typeof message.text === "string" && message.text.length > 0 ? message.text : undefined;
    const type = message.action === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown";
    const params = { type, key: message.key, code: String(message.code ?? ""), windowsVirtualKeyCode: clamp(message.keyCode, 0, 255), modifiers: modifiersOf(message) };
    if (text) params.text = text;
    return [{ method: "Input.dispatchKeyEvent", params }];
};

const toCdpCalls = (message) => {
    switch (message?.type) {
        case "mouse": return mouseToCdp(message);
        case "key": return keyToCdp(message);
        case "resize": return viewportCalls(message);
        case "dialogReply": return [{
            method: "Page.handleJavaScriptDialog",
            params: { accept: !!message.accept, ...(typeof message.promptText === "string" && { promptText: message.promptText }) },
        }];
        case "paste":
            return typeof message.text === "string" && message.text.length > 0
                ? [{ method: "Input.insertText", params: { text: message.text.slice(0, PASTE_LIMIT) } }]
                : [];
        default: return [];
    }
};

const assertNavigableUrl = (raw) => {
    let url;
    try {
        url = new URL(String(raw));
    } catch {
        throw new BrowserError(BrowserErrorCode.INVALID_URL, `Not a valid URL: ${raw}. Include the scheme, e.g. https://example.com`);
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol))
        throw new BrowserError(BrowserErrorCode.INVALID_URL, `Only http and https URLs can be opened, not ${url.protocol}`);
    return url.href;
};

module.exports = { SCREENCAST, toCdpCalls, viewportCalls, clampViewport, assertNavigableUrl };

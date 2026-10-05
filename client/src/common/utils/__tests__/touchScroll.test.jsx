import { expect, test, vi } from "vitest";
import { attachTouchScroll, touchScrollMode } from "../touchScroll.js";

const touchEvent = (type, y, x = 50) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] });
    return event;
};

const swipe = (element, fromY, toY, x = 50) => {
    element.dispatchEvent(touchEvent("touchstart", fromY, x));
    for (let y = fromY; fromY < toY ? y <= toY : y >= toY; y += fromY < toY ? 10 : -10) {
        element.dispatchEvent(touchEvent("touchmove", y, x));
    }
    element.dispatchEvent(touchEvent("touchend", toY, x));
};

const fakeTerminal = ({ mouseTrackingMode = "none", bufferType = "normal" } = {}) => ({
    rows: 20,
    modes: { mouseTrackingMode },
    buffer: { active: { type: bufferType } },
    _core: { _renderService: { dimensions: { css: { cell: { height: 10 } } } } },
    scrollLines: vi.fn(),
    input: vi.fn(),
});

const terminalElement = () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "clientHeight", { value: 200 });
    return element;
};

test("the swipe reaches whoever owns the scrollback", () => {
    expect(touchScrollMode({ mouseTracking: false, alternateBuffer: false })).toBe("local");
    expect(touchScrollMode({ mouseTracking: false, alternateBuffer: true })).toBe("page");
    expect(touchScrollMode({ mouseTracking: true, alternateBuffer: true })).toBe("wheel");
});

test("dragging down in the shell scrolls the local scrollback back, line by line", () => {
    const term = fakeTerminal();
    const element = terminalElement();
    attachTouchScroll(term, element);

    swipe(element, 20, 80);

    const lines = term.scrollLines.mock.calls.reduce((sum, [n]) => sum + n, 0);
    expect(lines).toBeLessThan(0);
    expect(lines).toBeGreaterThanOrEqual(-6);
});

test("in a full-screen application a half-height drag sends one page key", () => {
    const term = fakeTerminal({ bufferType: "alternate" });
    const element = terminalElement();
    attachTouchScroll(term, element);

    swipe(element, 20, 130);
    expect(term.input.mock.calls).toEqual([["\x1b[5~", true]]);

    term.input.mockClear();
    swipe(element, 130, 20);
    expect(term.input.mock.calls).toEqual([["\x1b[6~", true]]);
});

test("a horizontal drag is left alone", () => {
    const term = fakeTerminal();
    const element = terminalElement();
    attachTouchScroll(term, element);

    element.dispatchEvent(touchEvent("touchstart", 50, 10));
    element.dispatchEvent(touchEvent("touchmove", 55, 60));
    element.dispatchEvent(touchEvent("touchmove", 90, 70));
    element.dispatchEvent(touchEvent("touchend", 90, 70));

    expect(term.scrollLines).not.toHaveBeenCalled();
});

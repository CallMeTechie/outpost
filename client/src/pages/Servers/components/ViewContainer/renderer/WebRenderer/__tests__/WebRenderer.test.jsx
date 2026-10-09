import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createContext } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import WebRenderer from "../WebRenderer.jsx";

vi.mock("@/common/contexts/UserContext.jsx", () => ({
    UserContext: createContext({ sessionToken: "test-token" }),
}));

vi.mock("@/common/contexts/KeymapContext.jsx", () => ({
    useKeymaps: () => ({ keymaps: [], getParsedKeybind: () => null }),
    matchesKeybind: () => false,
}));

class FakeSocket {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        FakeSocket.instances.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

afterEach(() => vi.unstubAllGlobals());

const session = { id: "browser-1", type: "browser", browser: { title: "Docs", url: "https://docs.test/" } };

const connect = () => {
    renderWithProviders(<WebRenderer session={session} markSessionErrored={vi.fn()} />);
    const ws = FakeSocket.instances[0];
    act(() => ws.open());
    return ws;
};

test("the indicator names the running tool and the pause switch sends pause", () => {
    const ws = connect();
    expect(ws.url).toContain("/api/ws/browser");
    expect(ws.url).toContain("browserSessionId=browser-1");

    act(() => ws.receive({ type: "agent", active: true, tool: "browser_click", paused: false }));
    expect(screen.getByText("Claude: browser_click")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pause agent" }));
    expect(ws.sent.at(-1)).toEqual({ type: "pause", paused: true });
});

test("a page dialog is answered by the human and the reply goes to the server", () => {
    const ws = connect();
    act(() => ws.receive({ type: "dialog", id: 1, kind: "confirm", message: "Delete everything?", defaultPrompt: "", origin: "https://a.test" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("https://a.test says");
    expect(screen.getByRole("alertdialog").textContent).toContain("Delete everything?");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(ws.sent.at(-1)).toEqual({ type: "dialogReply", id: 1, accept: false });
    expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("a hidden browser tab holds no connection; showing it connects", () => {
    const view = renderWithProviders(<WebRenderer session={session} markSessionErrored={vi.fn()} isVisible={false} />);
    expect(FakeSocket.instances).toHaveLength(0);

    view.rerender(<WebRenderer session={session} markSessionErrored={vi.fn()} isVisible />);
    expect(FakeSocket.instances).toHaveLength(1);
    const ws = FakeSocket.instances[0];

    view.rerender(<WebRenderer session={session} markSessionErrored={vi.fn()} isVisible={false} />);
    expect(ws.readyState).toBe(3);
});

test("a tap on a page text field opens the soft keyboard", () => {
    const keyboard = { show: vi.fn(), hide: vi.fn() };
    vi.stubGlobal("navigator", { ...navigator, virtualKeyboard: keyboard });
    const ws = connect();
    const stage = document.querySelector(".web-stage");

    fireEvent.pointerDown(stage, { pointerType: "touch" });
    expect(fireEvent.mouseDown(stage, { button: 0 })).toBe(false);
    fireEvent.mouseUp(stage, { button: 0 });
    expect(ws.sent.at(-1)).toMatchObject({ type: "mouse", action: "up", focusCheck: true });

    act(() => ws.receive({ type: "focus", editable: true }));
    expect(document.activeElement).toBe(document.querySelector(".web-ime"));
    expect(keyboard.show).toHaveBeenCalled();
});

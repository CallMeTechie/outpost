import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createContext } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

// The WS-connect effect bails out without a sessionToken (XtermRenderer.jsx:406),
// and UserContext has no provider here.
vi.mock("@/common/contexts/UserContext.jsx", () => ({
    UserContext: createContext({ sessionToken: "test-token" }),
}));

// Import-time side effects, same recipe as the Monaco doubles: the real
// libraries touch the DOM/canvas as soon as they are imported, long before
// any component renders.
vi.mock("@xterm/xterm", () => {
    class Terminal {
        constructor() {
            this.cols = 80;
            this.rows = 24;
            this.textarea = document.createElement("textarea");
            this.buffer = { active: { cursorX: 0, cursorY: 0 } };
            this._selection = "";
            Terminal.instances.push(this);
        }
        open() {}
        loadAddon() {}
        write() {}
        dispose() {}
        focus() {}
        paste() {}
        clearSelection() {}
        getSelection() { return this._selection; }
        onData() { return { dispose: vi.fn() }; }
        onResize() { return { dispose: vi.fn() }; }
        onKey() { return { dispose: vi.fn() }; }
        onScroll() { return { dispose: vi.fn() }; }
        onCursorMove() { return { dispose: vi.fn() }; }
        onTitleChange() { return { dispose: vi.fn() }; }
        onSelectionChange() { return { dispose: vi.fn() }; }
        attachCustomKeyEventHandler() {}
    }
    Terminal.instances = [];
    return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
    FitAddon: class FitAddon {
        fit() {}
        dispose() {}
    },
}));

vi.mock("@/common/contexts/PreferencesContext.jsx", () => ({
    usePreferences: () => ({
        theme: "dark",
        getCurrentTheme: () => ({ foreground: "#ffffff", background: "#000000" }),
        selectedFont: "monospace",
        fontSize: 14,
        cursorStyle: "block",
        cursorBlink: true,
        selectedTheme: "dark",
        smartCopyPaste: false,
        passwordPromptDetection: false,
    }),
}));

vi.mock("@/common/contexts/SnippetContext.jsx", () => ({
    useSnippets: () => ({ allSnippets: [], sourceSnippets: [] }),
}));

class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    constructor(url) { this.url = url; }
    send() {}
    close() { this.readyState = 3; }
}

let XtermRenderer;
let Terminal;

beforeEach(async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    ({ default: XtermRenderer } = await import("@/pages/Servers/components/ViewContainer/renderer/XtermRenderer.jsx"));
    ({ Terminal } = await import("@xterm/xterm"));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const SESSION = { id: "s1", server: {} };

// --- XtermRenderer ---

test("the copy entry is disabled without a selection and enabled with one", () => {
    renderWithProviders(
        <XtermRenderer session={SESSION} terminalRefs={{ current: {} }} />,
    );

    const container = document.querySelector(".xterm-container");

    // readSelection() is falsy on the first open -- no selection yet.
    fireEvent.contextMenu(container);
    expect(screen.getByText("Copy").closest('[role="menuitem"]')).toHaveAttribute("aria-disabled", "true");

    const term = Terminal.instances.at(-1);
    term._selection = "some text";

    // Reopening re-runs handleContextMenu, which captures the flag anew.
    fireEvent.contextMenu(container);
    expect(screen.getByText("Copy").closest('[role="menuitem"]')).toHaveAttribute("aria-disabled", "false");
});

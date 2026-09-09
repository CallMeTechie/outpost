import { beforeEach, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScriptDialog } from "@/pages/Snippets/components/ScriptDialog/ScriptDialog.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

// vi.hoisted + a factory, for the reasons spelled out in IdentityDialog.test.jsx:8-21.
const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

// Module-level: ScriptDialog.jsx:18 calls loader.config({ monaco }) on import,
// so the real packages run before any test does. The stub only has to carry the
// value, since the three cases here drive the name field, never the editor.
vi.mock("monaco-editor", () => ({}));
vi.mock("@monaco-editor/react", () => ({
    default: ({ value, onChange }) => (
        <textarea aria-label="script content" value={value}
                  onChange={(e) => onChange(e.target.value)} />
    ),
    loader: { config: () => {} },
}));

const open = () => renderWithProviders(
    <ScriptDialog open={true} onClose={() => {}} />,
    { providers: [ToastProvider] },
);

const confirmTitle = () => screen.queryByText("Unsaved Changes");

beforeEach(() => { requestDouble.reset(); });

// --- ScriptDialog ---

test("a freshly opened dialog closes without asking", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(confirmTitle()).not.toBeInTheDocument();
});

test("typing into the dialog makes closing ask first", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByPlaceholderText("Script name"), "x");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.getByText("Unsaved Changes")).toBeInTheDocument();
});

test("undoing the change makes closing quiet again", async () => {
    const user = userEvent.setup();
    open();

    const nameField = screen.getByPlaceholderText("Script name");
    await user.type(nameField, "x");
    await user.clear(nameField);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(confirmTitle()).not.toBeInTheDocument();
});

test("the footer cancel asks about unsaved changes", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByPlaceholderText("Script name"), "x");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Unsaved Changes")).toBeInTheDocument();
});

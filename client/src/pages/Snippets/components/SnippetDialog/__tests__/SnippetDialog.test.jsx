import { beforeEach, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SnippetDialog } from "@/pages/Snippets/components/SnippetDialog/SnippetDialog.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

// vi.hoisted + a factory, for the reasons spelled out in IdentityDialog.test.jsx:8-21.
const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

const open = () => renderWithProviders(
    <SnippetDialog open={true} onClose={() => {}} />,
    { providers: [ToastProvider] },
);

const confirmTitle = () => screen.queryByText("Unsaved Changes");

beforeEach(() => { requestDouble.reset(); });

// --- SnippetDialog ---

test("a freshly opened dialog closes without asking", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(confirmTitle()).not.toBeInTheDocument();
});

test("typing into the dialog makes closing ask first", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByPlaceholderText("Snippet name"), "x");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.getByText("Unsaved Changes")).toBeInTheDocument();
});

test("undoing the change makes closing quiet again", async () => {
    const user = userEvent.setup();
    open();

    const nameField = screen.getByPlaceholderText("Snippet name");
    await user.type(nameField, "x");
    await user.clear(nameField);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(confirmTitle()).not.toBeInTheDocument();
});

test("the footer cancel asks about unsaved changes", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByPlaceholderText("Snippet name"), "x");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Unsaved Changes")).toBeInTheDocument();
});

test("the footer cancel does not submit the form", async () => {
    const user = userEvent.setup();
    open();

    // Both fields: handleSubmit (SnippetDialog.jsx:62-65) returns before any
    // request while name or command is empty, so a name-only case would stay
    // green even if the click did submit.
    await user.type(screen.getByPlaceholderText("Snippet name"), "x");
    await user.type(screen.getByPlaceholderText("Enter your command"), "echo x");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // A submit would have gone through RequestUtil; the double records every call.
    expect(requestDouble.calls).toEqual([]);
});

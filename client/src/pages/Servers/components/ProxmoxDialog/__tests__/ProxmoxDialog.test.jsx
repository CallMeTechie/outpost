import { beforeEach, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProxmoxDialog } from "@/pages/Servers/components/ProxmoxDialog/ProxmoxDialog.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

// vi.hoisted + a factory, for the reasons spelled out in IdentityDialog.test.jsx:8-21.
const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

const open = () => renderWithProviders(
    <ProxmoxDialog open={true} onClose={() => {}} />,
    { providers: [ToastProvider] },
);

const confirmTitle = () => screen.queryByText("Unsaved Changes");

beforeEach(() => { requestDouble.reset(); });

// --- ProxmoxDialog ---

test("a freshly opened dialog closes without asking", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(confirmTitle()).not.toBeInTheDocument();
});

test("typing into the dialog makes closing ask first", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByPlaceholderText("Name"), "x");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.getByText("Unsaved Changes")).toBeInTheDocument();
});

test("undoing the change makes closing quiet again", async () => {
    const user = userEvent.setup();
    open();

    const nameField = screen.getByPlaceholderText("Name");
    await user.type(nameField, "x");
    await user.clear(nameField);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(confirmTitle()).not.toBeInTheDocument();
});

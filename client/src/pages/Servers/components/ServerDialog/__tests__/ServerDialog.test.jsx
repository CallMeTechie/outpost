import { beforeEach, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerDialog } from "@/pages/Servers/components/ServerDialog/ServerDialog.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

// vi.hoisted + a factory, for the reasons spelled out in IdentityDialog.test.jsx:8-21.
const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

// initialProtocol="ssh": without it config.protocol starts undefined, and
// DetailsPage's protocol SelectBox auto-selects its first option on mount
// (SelectBox.jsx:90-92), changing `config` right after initialValues.current
// was seeded and leaving the dialog permanently dirty - a pre-existing
// SelectBox/ServerDialog interaction this task does not touch. "ssh" hides
// the protocol picker (fieldConfig.showProtocol is false for it), which
// sidesteps the interaction without masking the isDirty behavior under test.
const open = () => renderWithProviders(
    <ServerDialog open={true} onClose={() => {}} initialProtocol="ssh" />,
    { providers: [ToastProvider] },
);

const confirmTitle = () => screen.queryByText("Unsaved Changes");

beforeEach(() => { requestDouble.reset(); });

// --- ServerDialog ---

test("a freshly opened dialog closes without asking", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(confirmTitle()).not.toBeInTheDocument();
});

test("typing into the dialog makes closing ask first", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByPlaceholderText("Server name"), "x");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.getByText("Unsaved Changes")).toBeInTheDocument();
});

test("undoing the change makes closing quiet again", async () => {
    const user = userEvent.setup();
    open();

    const nameField = screen.getByPlaceholderText("Server name");
    await user.type(nameField, "x");
    await user.clear(nameField);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(confirmTitle()).not.toBeInTheDocument();
});

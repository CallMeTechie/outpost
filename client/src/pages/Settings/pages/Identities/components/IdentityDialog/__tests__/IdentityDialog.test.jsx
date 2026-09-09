import { beforeEach, expect, test, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IdentityDialog } from "@/pages/Settings/pages/Identities/components/IdentityDialog/IdentityDialog.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

// vi.hoisted is moved above every static import, not just above vi.mock, so a
// statically imported factory would not be initialised yet - the file would die
// with "Cannot access '__vi_esm_0__' before initialization". Pulling the double
// in dynamically inside the hoisted block is the way around it.
const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

// With a factory, never bare: without one vitest loads the real module to learn
// its shape, and that drags RequestUtil.js:2-5 - four @tauri-apps/* imports -
// into the test. The specifier is the exact one IdentityDialog.jsx:4 imports;
// the alias resolves through vite.config.js, which vitest.config.js inherits.
vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

const NAME_PLACEHOLDER = "Enter identity name";
const PASSWORD_PLACEHOLDER = "Enter password";

const open = () => renderWithProviders(
    <IdentityDialog open={true} onClose={() => {}} />,
    { providers: [ToastProvider] },
);

beforeEach(() => { requestDouble.reset(); });

// --- IdentityDialog ---

test("a freshly opened dialog closes without asking", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.queryByText("Unsaved Changes")).not.toBeInTheDocument();
});

test("after typing, closing asks first", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByPlaceholderText(NAME_PLACEHOLDER), "ops");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.getByText("Unsaved Changes")).toBeInTheDocument();
});

test("taking the input back makes the dialog clean again", async () => {
    const user = userEvent.setup();
    open();

    const nameField = screen.getByPlaceholderText(NAME_PLACEHOLDER);
    await user.type(nameField, "ops");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    // "Cancel" appears twice while the confirm is up - once in the dialog's own
    // footer (IdentityDialog.jsx:209) and once in the confirm (Dialog.jsx:119),
    // which are siblings and therefore both in the document. An unscoped query
    // throws "Found multiple elements".
    const confirm = screen.getByText("Unsaved Changes").closest(".dialog-confirm");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));

    await user.clear(nameField);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));

    expect(screen.queryByText("Unsaved Changes")).not.toBeInTheDocument();
});

test("the footer cancel asks about unsaved changes", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByPlaceholderText(NAME_PLACEHOLDER), "ops");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Unsaved Changes")).toBeInTheDocument();
});

test("submitting a blank name shows the error toast and sends no request", async () => {
    const user = userEvent.setup();
    open();

    // Two fields, not one. The form carries `required` twice: on the name
    // (IdentityDialog.jsx:156) and - because isEditing is false and authType
    // defaults to "password" - on the password (:185). jsdom runs interactive
    // validation before it fires `submit`, so a single empty required control
    // means handleSubmit never runs and this case would fail for a reason that
    // has nothing to do with the branch under test.
    //
    // The name gets a single space: it satisfies `required` and still trips the
    // !name.trim() guard at IdentityDialog.jsx:75-78, which is the branch this
    // case exists for. handleSubmit returns there, so the password value never
    // reaches its own guard and is deliberately arbitrary.
    await user.type(screen.getByPlaceholderText(NAME_PLACEHOLDER), " ");
    await user.type(screen.getByPlaceholderText(PASSWORD_PLACEHOLDER), "irrelevant");
    await user.click(screen.getByRole("button", { name: "Create Identity" }));

    expect(await screen.findByText("Identity name is required")).toBeInTheDocument();
    expect(requestDouble.calls).toEqual([]);
});

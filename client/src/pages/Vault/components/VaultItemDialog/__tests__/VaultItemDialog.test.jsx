import { beforeEach, expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VaultItemDialog } from "@/pages/Vault/components/VaultItemDialog/VaultItemDialog.jsx";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { TagContext } from "@/common/contexts/TagContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

const item = {
    id: 5, ref: "portal-login", accountId: 1, organizationId: null, ownerName: null, name: "portal-login", type: "login",
    description: "", fields: { username: "ma.backes", origins: ["https://portal.example.com"] },
    approvalRequired: true, allServers: false, bindings: [], secretFields: ["password"], lastUsedAt: null,
    canManage: true, canReveal: true, unreadable: false,
};

const Targets = ({ children }) => (
    <ServerContext.Provider value={{ servers: [] }}>
        <TagContext.Provider value={{ tags: [] }}>{children}</TagContext.Provider>
    </ServerContext.Provider>
);

const dialog = (open) => (
    <VaultItemDialog open={open} onClose={() => {}} item={item} onSaved={() => {}} defaultOwner="personal"
                     owners={[{ value: "personal", label: "Personal (ma.backes)", organizationId: null }]} />
);
const editItem = () => renderWithProviders(dialog(true), { providers: [Targets] });

beforeEach(() => {
    requestDouble.reset();
    requestDouble.stub("patchRequest", "vault/items/5", { item, secretsCleared: true });
});

test("ein geänderter Ursprung verwirft den gespeicherten Wert: Speichern erst mit neuem Passwort und Ursprung", async () => {
    const user = userEvent.setup();
    editItem();
    const save = screen.getByRole("button", { name: "Save" });
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "stored — leave empty to keep");

    await user.clear(screen.getByLabelText("Origin"));

    expect(screen.getByText("Target changed — stored values will be discarded. Enter them again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("placeholder", "Enter Password");
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText("Password"), "Wn4-eTq8");
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText("Origin"), "https://login.example.com");
    await user.click(save);

    expect(requestDouble.calls).toEqual([{
        method: "patchRequest", path: "vault/items/5",
        body: expect.objectContaining({
            fields: { username: "ma.backes", origins: ["https://login.example.com"] },
            secrets: { password: "Wn4-eTq8" },
        }),
    }]);
});

test("ohne Zieländerung schickt Speichern kein leeres Geheimfeld mit, der gespeicherte Wert bleibt; ein getippter Wert überdauert das Schließen nicht", async () => {
    const user = userEvent.setup();
    const { rerender } = editItem();

    await user.clear(screen.getByLabelText("User"));
    await user.type(screen.getByLabelText("User"), "admin");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(requestDouble.calls).toHaveLength(1);
    expect(requestDouble.calls[0].body.fields).toEqual({ username: "admin", origins: ["https://portal.example.com"] });
    expect(requestDouble.calls[0].body).not.toHaveProperty("secrets");

    await user.type(screen.getByLabelText("Password"), "Wn4-eTq8");
    rerender(dialog(false));
    rerender(dialog(true));
    expect(await screen.findByLabelText("Password")).toHaveValue("");
});

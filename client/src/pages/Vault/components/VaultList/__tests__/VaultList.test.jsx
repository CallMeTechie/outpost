import { expect, test, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VaultList } from "@/pages/Vault/components/VaultList/VaultList.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

const items = [{ id: 1, name: "portal-login", type: "login", fields: {}, approvalRequired: false }];
const list = (props) => (
    <VaultList items={items} selectedId={null} onSelect={() => {}} onCreate={() => {}} canCreate {...props} />
);

test("Rechtsklick in die Liste bietet Neuer Eintrag an und lässt die Auswahl unberührt; ohne Berechtigung gibt es kein Menü", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const onSelect = vi.fn();
    const { unmount } = renderWithProviders(list({ onCreate, onSelect }));

    expect(fireEvent.contextMenu(screen.getByText("portal-login"))).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(await screen.findByText("New entry"));
    expect(onCreate).toHaveBeenCalledTimes(1);

    unmount();
    renderWithProviders(list({ canCreate: false }));
    expect(fireEvent.contextMenu(screen.getByText("portal-login"))).toBe(true);
    expect(screen.queryByText("New entry")).not.toBeInTheDocument();
});

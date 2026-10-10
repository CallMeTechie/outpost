import { beforeEach, expect, test, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import testI18n from "@/test/i18n.js";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { Vault } from "../Vault.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});
const vaultAvailable = vi.hoisted(() => ({ enabled: true, impersonating: false, refresh: vi.fn() }));

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());
vi.mock("@/common/hooks/useVaultAvailable.js", () => ({ useVaultAvailable: () => vaultAvailable }));

const t = (key, options) => testI18n.t(key, options);
const settings = (overrides = {}) => ({ keyStatus: "active", agentUrl: null, trustProxyUnsafe: false, ...overrides });
const mount = () => renderWithProviders(<Vault />, { providers: [ToastProvider] });

beforeEach(() => {
    requestDouble.reset();
    vaultAvailable.refresh.mockReset();
});

test.each([
    ["missing", "settings.vault.key.missing", "settings.vault.key.missingText"],
    ["mismatch", "settings.vault.key.mismatch", "settings.vault.key.mismatchText"],
])("key status %s says that the vault is off and why", async (keyStatus, pillKey, textKey) => {
    requestDouble.stub("getRequest", "vault/settings", settings({ keyStatus }));
    mount();

    expect(await screen.findByText(t(textKey))).toBeInTheDocument();
    expect(screen.getByText(t(pillKey))).toBeInTheDocument();
});

test("an address without http or https blocks saving; a valid one is saved and refreshes availability", async () => {
    const user = userEvent.setup();
    requestDouble.stub("getRequest", "vault/settings", settings());
    requestDouble.stub("patchRequest", "vault/settings", settings({ agentUrl: "http://192.168.2.10:6989" }));
    mount();
    const field = await screen.findByRole("textbox");
    const save = () => screen.getByRole("button", { name: t("settings.vault.saveSettings") });

    await user.type(field, "192.168.2.10:6989");
    expect(screen.getByText(t("settings.vault.agentUrl.invalid"))).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await user.clear(field);
    await user.type(field, "http://192.168.2.10:6989");
    await user.click(save());

    await waitFor(() => expect(requestDouble.calls).toContainEqual(
        { method: "patchRequest", path: "vault/settings", body: { agentUrl: "http://192.168.2.10:6989" } },
    ));
    expect(vaultAvailable.refresh).toHaveBeenCalled();
});

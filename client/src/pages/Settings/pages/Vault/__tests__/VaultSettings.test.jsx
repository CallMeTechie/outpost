import { beforeEach, expect, test, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import testI18n from "@/test/i18n.js";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import AgentKeysSection from "@/pages/Settings/pages/Account/components/AgentKeysSection";
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
const servers = { getServerById: () => null };
const Servers = ({ children }) => <ServerContext.Provider value={servers}>{children}</ServerContext.Provider>;
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

test("an empty address is suggested from the browser; a wrong one blocks saving, a valid one is saved with the binding default", async () => {
    const user = userEvent.setup();
    requestDouble.stub("getRequest", "vault/settings", settings());
    requestDouble.stub("patchRequest", "vault/settings", settings({ agentUrl: "http://192.168.2.10:6989", ipBindingDefault: false }));
    mount();
    const field = await screen.findByRole("textbox");
    const save = () => screen.getByRole("button", { name: t("settings.vault.saveSettings") });
    expect(field).toHaveValue(window.location.origin);
    expect(screen.getByText(t("settings.vault.agentUrl.suggested"))).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, "192.168.2.10:6989");
    expect(screen.getByText(t("settings.vault.agentUrl.invalid"))).toBeInTheDocument();
    expect(screen.queryByText(t("settings.vault.agentUrl.suggested"))).not.toBeInTheDocument();
    expect(save()).toBeDisabled();

    await user.clear(field);
    await user.type(field, "http://192.168.2.10:6989");
    await user.click(screen.getByRole("checkbox"));
    await user.click(save());

    await waitFor(() => expect(requestDouble.calls).toContainEqual(
        { method: "patchRequest", path: "vault/settings", body: { agentUrl: "http://192.168.2.10:6989", ipBindingDefault: false } },
    ));
    expect(vaultAvailable.refresh).toHaveBeenCalled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
});

test("failed loads show an error with retry instead of loading text or the empty state", async () => {
    const user = userEvent.setup();
    requestDouble.stub("getRequest", "vault/settings", new Error("down"));
    requestDouble.stub("getRequest", "vault/agent-keys", new Error("down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithProviders(<><Vault /><AgentKeysSection /></>, { providers: [ToastProvider, Servers] });

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((alert) => alert.textContent)).toEqual(expect.arrayContaining([
        expect.stringContaining(t("settings.vault.errors.loadSettings")),
        expect.stringContaining(t("settings.account.agentKeys.loadFailed")),
    ]));
    expect(screen.queryByText(t("settings.vault.loading"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("settings.account.agentKeys.empty"))).not.toBeInTheDocument();

    requestDouble.stub("getRequest", "vault/settings", settings());
    requestDouble.stub("getRequest", "vault/agent-keys", { keys: [] });
    const [vaultRetry, keysRetry] = screen.getAllByRole("button", { name: t("settings.vault.errors.retry") });
    await user.click(vaultRetry);
    await user.click(keysRetry);

    expect(await screen.findByText(t("settings.account.agentKeys.empty"))).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: t("settings.vault.saveSettings") })).toBeInTheDocument();
    errors.mockRestore();
});

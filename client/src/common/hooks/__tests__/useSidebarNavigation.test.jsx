import { beforeEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import testI18n from "@/test/i18n.js";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { useSidebarNavigation } from "../useSidebarNavigation.js";
import { useVaultAvailable } from "../useVaultAvailable.js";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

// navigationConfig.jsx imports every settings page, and the theme editor among them loads
// Monaco, which jsdom cannot run (document.queryCommandSupported).
vi.mock("monaco-editor", () => ({}));
vi.mock("@monaco-editor/react", () => ({ default: () => null, loader: { config: () => {} } }));

const wrapperFor = (accountId) => {
    const user = { id: accountId, isAdmin: false, permissions: [] };
    const Wrapper = ({ children }) => (
        <I18nextProvider i18n={testI18n}>
            <UserContext.Provider value={{ user, hasPermission: () => false }}>{children}</UserContext.Provider>
        </I18nextProvider>
    );
    return Wrapper;
};

const navigationFor = (accountId) => renderHook(() => useSidebarNavigation(), { wrapper: wrapperFor(accountId) });

beforeEach(() => {
    requestDouble.reset();
    requestDouble.stub("getRequest", "browser/available", { enabled: false });
});

test("Vault erscheint nach Snippets nur, wenn vault/available canUse meldet; refresh() erreicht jeden eingehängten Hook des Kontos", async () => {
    requestDouble.stub("getRequest", "vault/available", { enabled: true, canUse: true });
    const allowed = navigationFor(1);
    await waitFor(() => expect(allowed.result.current.map((item) => item.key)).toEqual(["servers", "monitoring", "snippets", "vault"]));
    allowed.unmount();

    requestDouble.stub("getRequest", "vault/available", { enabled: true, canUse: false });
    const denied = navigationFor(2);
    await waitFor(() => expect(requestDouble.calls.filter((call) => call.path === "vault/available")).toHaveLength(2));
    expect(denied.result.current.map((item) => item.key)).toEqual(["servers", "monitoring", "snippets"]);

    requestDouble.stub("getRequest", "vault/available", { enabled: true, canUse: true });
    const settingsPage = renderHook(() => useVaultAvailable(), { wrapper: wrapperFor(2) });
    await act(() => settingsPage.result.current.refresh());
    await waitFor(() => expect(denied.result.current.map((item) => item.key)).toEqual(["servers", "monitoring", "snippets", "vault"]));
});

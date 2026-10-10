import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { VaultDetail } from "@/pages/Vault/components/VaultDetail/VaultDetail.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());

const MASK = "••••••••••••";

const item = {
    id: 5, ref: "portal-login", accountId: 1, organizationId: null, ownerName: null, name: "portal-login", type: "login",
    description: "", fields: { username: "ma.backes", origins: ["https://portal.example.com"] },
    approvalRequired: true, allServers: false, bindings: [], secretFields: ["password"], lastUsedAt: null,
    canManage: true, canReveal: true, unreadable: false,
};

const show = (shown, impersonating = false) => renderWithProviders(
    <VaultDetail item={shown} impersonating={impersonating} onEdit={() => {}} onDelete={() => {}} />,
    { providers: [ToastProvider] },
);

beforeEach(() => { requestDouble.reset(); });
afterEach(() => { vi.useRealTimers(); });

test("ein angezeigter Wert verbirgt sich nach 30 Sekunden wieder hinter zwölf Punkten", async () => {
    vi.useFakeTimers();
    requestDouble.stub("getRequest", "vault/items/5/secrets/password", { value: "Wn4-eTq8-Rz2x" });
    show(item);

    expect(screen.getByText(MASK)).toBeInTheDocument();
    // fireEvent instead of userEvent: userEvent schedules its own timers, which the fake clock would hold.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Show" })); });
    expect(screen.getByText("Wn4-eTq8-Rz2x")).toBeInTheDocument();
    expect(screen.getByText("shown, hides in 30 s")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(29_999));
    expect(screen.getByText("Wn4-eTq8-Rz2x")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Wn4-eTq8-Rz2x")).not.toBeInTheDocument();
    expect(screen.getByText(MASK)).toBeInTheDocument();
});

test.each([
    ["ohne Anzeigerecht", { ...item, canReveal: false }, false],
    ["in einer Impersonations-Sitzung", item, true],
])("%s gibt es weder Anzeigen noch Kopieren, nur den Hinweis für Agenten", (_, shown, impersonating) => {
    show(shown, impersonating);

    expect(screen.queryByRole("button", { name: "Show" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.getByText("usable by agents only")).toBeInTheDocument();
    expect(requestDouble.calls).toEqual([]);
});

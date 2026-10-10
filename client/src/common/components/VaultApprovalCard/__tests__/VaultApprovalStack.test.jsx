import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import testI18n from "@/test/i18n.js";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { StateStreamContext, STATE_TYPES } from "@/common/contexts/StateStreamContext.jsx";
import { VaultApprovalStack } from "../VaultApprovalStack.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());
vi.mock("@/common/hooks/useVaultAvailable.js", () => ({
    useVaultAvailable: () => ({ impersonating: false }),
}));

const t = (key, options) => testI18n.t(key, options);

// Module level, not inside a component: the stack registers from an effect, and the
// handler has to leave that effect without a write to an outer variable during render.
const stream = { handler: null };
const streamValue = {
    registerHandler: (type, handler) => {
        if (type === STATE_TYPES.VAULT_APPROVALS) stream.handler = handler;
        return () => {};
    },
};
const Stream = ({ children }) => (
    <StateStreamContext.Provider value={streamValue}>{children}</StateStreamContext.Provider>
);

const mount = () => renderWithProviders(<VaultApprovalStack />, { providers: [ToastProvider, Stream] });
const push = (list) => act(() => { stream.handler(list); });
// The server clock runs an hour ahead: only remainingMs may drive the countdown.
const SERVER_CLOCK_AHEAD_MS = 3_600_000;
const approval = (id, remainingMs) => ({
    id, agentType: "claude", entryName: "web01", item: "portal-login",
    target: "https://portal.example.com", expiresAt: Date.now() + SERVER_CLOCK_AHEAD_MS + remainingMs, remainingMs,
});
const stack = () => document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-CARD']");
const button = (key) => screen.getByRole("button", { name: t(key) });

beforeEach(() => {
    requestDouble.reset();
    stream.handler = null;
});
afterEach(() => { vi.useRealTimers(); });

test("the countdown runs from remainingMs on receipt; an expired card shows its error state for five seconds, then goes", () => {
    vi.useFakeTimers({ now: 0 });
    mount();
    push([approval("a1", 90_000)]);

    expect(screen.getByText("1:30")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText("1:00")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText(t("vault.approval.expired"))).toBeInTheDocument();
    expect(screen.getByText("0:00")).toBeInTheDocument();
    expect(button("vault.approval.actions.once")).toBeDisabled();

    act(() => { vi.advanceTimersByTime(5_000); });
    expect(stack()).toBeNull();
});

test("Once sends the decision, shows the sending state, and removes the card on success; a request from an impersonation says so and offers no session", async () => {
    const user = userEvent.setup();
    let resolve;
    requestDouble.stub("postRequest", "vault/approvals/a1", new Promise((r) => { resolve = r; }));
    mount();
    push([{ ...approval("a1", 120_000), impersonated: true }]);

    expect(screen.getByText(t("vault.approval.impersonated"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("vault.approval.actions.session") })).not.toBeInTheDocument();
    await user.click(button("vault.approval.actions.once"));

    expect(screen.getByText(t("vault.approval.sending"))).toBeInTheDocument();
    expect(button("vault.approval.actions.deny")).toBeDisabled();
    expect(requestDouble.calls).toContainEqual({ method: "postRequest", path: "vault/approvals/a1", body: { decision: "once" } });

    await act(async () => { resolve({ success: true }); });
    expect(stack()).toBeNull();
});

test.each([404, 409, 410])("an answer the server refuses with %i removes the card without a toast", async (code) => {
    const user = userEvent.setup();
    requestDouble.stub("postRequest", "vault/approvals/a1", Object.assign(new Error("Approval closed"), { code }));
    mount();
    push([approval("a1", 120_000)]);

    await user.click(button("vault.approval.actions.deny"));

    await waitFor(() => expect(stack()).toBeNull());
    expect(screen.queryByText("Approval closed")).not.toBeInTheDocument();
});

test("a failed send keeps the card, re-enables it and names the reason in a toast", async () => {
    const user = userEvent.setup();
    requestDouble.stub("postRequest", "vault/approvals/a1", Object.assign(new Error("Too many requests"), { code: 429 }));
    mount();
    push([approval("a1", 120_000)]);

    await user.click(button("vault.approval.actions.session"));

    expect(await screen.findByText("Too many requests")).toBeInTheDocument();
    expect(stack()).not.toBeNull();
    expect(button("vault.approval.actions.session")).toBeEnabled();
});

test("Esc on the focused card denies", async () => {
    const user = userEvent.setup();
    requestDouble.stub("postRequest", "vault/approvals/a1", { success: true });
    mount();
    push([approval("a1", 120_000)]);

    act(() => { stack().querySelector(".vault-approval-card").focus(); });
    await user.keyboard("{Escape}");

    await waitFor(() => expect(requestDouble.calls).toContainEqual(
        { method: "postRequest", path: "vault/approvals/a1", body: { decision: "deny" } },
    ));
});

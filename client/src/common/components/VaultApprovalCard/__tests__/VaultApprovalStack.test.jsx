import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
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
const stream = { handlers: {} };
const streamValue = {
    registerHandler: (type, handler) => {
        stream.handlers[type] = handler;
        return () => {};
    },
};
const Stream = ({ children }) => (
    <StateStreamContext.Provider value={streamValue}>{children}</StateStreamContext.Provider>
);

const mount = () => renderWithProviders(<VaultApprovalStack />, { providers: [ToastProvider, Stream] });
const push = (list) => act(() => { stream.handlers[STATE_TYPES.VAULT_APPROVALS](list); });
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
    stream.handlers = {};
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

test("the card names tool, target and the field of a fill; only a writing request carries the badge; without allowSession there is no session button", () => {
    mount();
    push([
        { ...approval("a1", 120_000), item: "github-pat", tool: "vault_http", access: "write", target: "POST api.github.com/repos/o/r/issues" },
        { ...approval("a2", 110_000), item: "github-pat", tool: "git", access: "read", target: "Git · github.com/o/r" },
        { ...approval("a3", 100_000), item: "coolify-login", tool: "browser_fill_credential", access: "write", target: "https://coolify.example.net" },
        {
            ...approval("a4", 90_000), item: "coolify-token", tool: "browser_fill_secret", access: "write", target: "https://coolify.example.net",
            field: "<b>Comment</b>", allowSession: false,
        },
    ]);
    const cardOf = (line) => within(screen.getByText(line).closest(".vault-approval-card"));
    const badge = (line) => cardOf(line).queryByText(t("vault.approval.write"));
    const session = (line) => cardOf(line).queryByRole("button", { name: t("vault.approval.actions.session") });

    expect(badge("POST api.github.com/repos/o/r/issues")).toBeInTheDocument();
    expect(badge("Git · github.com/o/r")).not.toBeInTheDocument();
    expect(badge(t("vault.approval.target.fill", { origin: "https://coolify.example.net" }))).toBeInTheDocument();
    expect(document.querySelectorAll("[data-ui-id='UI-VAULT-APPROVAL-WRITE']")).toHaveLength(3);

    const fieldLine = "Fill in on https://coolify.example.net · field “<b>Comment</b>”";
    expect(screen.getByText(fieldLine)).toBeInTheDocument();
    expect(document.querySelector(".vault-approval-card b")).toBeNull();
    expect(session(fieldLine)).not.toBeInTheDocument();
    expect(session(t("vault.approval.target.fill", { origin: "https://coolify.example.net" }))).toBeInTheDocument();
});

const FINGERPRINT = "SHA256:3f9aT0qW8eLk2mN7vB1cX5zR4tY6uI9oP0aS3dFXc21";
const web02 = { ref: "server:12", name: "web02", user: "deploy", host: "192.168.2.40", port: 22 };
const nas = { ref: "server:13", name: "nas", user: "admin", host: "nas.example.net", port: 2222 };

test("ssh_exec: „führt aus“ statt „schreibt“, Ziel mit benutzer@host:port, Kasten „Neues Ziel“ mit vollem Fingerabdruck, Befehl als Text und über 20 Zeilen oder 1200 Zeichen eingeklappt; freigeben erst nach „Ganz anzeigen“, ablehnen immer", async () => {
    const user = userEvent.setup();
    const command = ["<b>echo start</b>", ...Array.from({ length: 41 }, (_, index) => `echo ${index + 1}`)].join("\n");
    mount();
    push([{
        ...approval("a1", 120_000), item: "deploy-web", tool: "ssh_exec", access: "exec", target: "server:12",
        sshTarget: web02, command, hostKey: { algorithm: "ssh-ed25519", fingerprint: FINGERPRINT, new: true }, allowSession: true,
    }]);

    expect(document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-EXEC']")).toHaveTextContent("executes");
    expect(document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-WRITE']")).toBeNull();
    expect(screen.getByText("SSH command · web02 · deploy@192.168.2.40:22")).toBeInTheDocument();
    expect(document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-HOSTKEY']"))
        .toHaveTextContent(`New target — ED25519 ${FINGERPRINT}. Compare with ssh-keyscan or at the console.`);

    const block = document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-COMMAND'] pre");
    expect(block.textContent.split("\n")).toHaveLength(20);
    expect(block.textContent.startsWith("<b>echo start</b>")).toBe(true);
    expect(block.querySelector("b")).toBeNull();
    expect(button("vault.approval.actions.once")).toBeDisabled();
    expect(button("vault.approval.actions.session")).toBeDisabled();
    expect(button("vault.approval.actions.deny")).toBeEnabled();
    expect(screen.getByText("Show the whole command before approving.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all (42 lines)" }));
    expect(block.textContent).toBe(command);
    expect(button("vault.approval.actions.once")).toBeEnabled();
    expect(button("vault.approval.actions.session")).toBeEnabled();
    expect(screen.queryByText("Show the whole command before approving.")).toBeNull();

    const oneLine = "x".repeat(3000);
    push([{ ...approval("a2", 120_000), item: "deploy-web", tool: "ssh_exec", access: "exec", target: "server:12", sshTarget: web02, command: oneLine }]);
    const single = document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-COMMAND'] pre");
    expect(single.textContent).toBe(oneLine.slice(0, 1200));
    expect(button("vault.approval.actions.once")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Show all (3000 characters)" }));
    expect(single.textContent).toBe(oneLine);
    expect(button("vault.approval.actions.once")).toBeEnabled();
});

test("Dateien: Hochladen nennt Quelle → Ziel mit Größe und „schreibt“, Holen zeigt „Größe nach der Freigabe“; „Für diese Sitzung“ nur mit allowSession", () => {
    mount();
    push([
        {
            ...approval("a1", 120_000), item: "deploy-nas", tool: "ssh_put", access: "write", target: "server:13", sshTarget: nas,
            allowSession: true, file: { from: "appmonster:~/build/app.tar.gz", to: "nas:/volume1/deploy/app.tar.gz", bytes: 50_541_363 },
        },
        {
            ...approval("a2", 110_000), item: "deploy-nas", tool: "ssh_get", access: "read", target: "server:13", sshTarget: nas,
            allowSession: false, file: { from: "nas:/volume1/logs/app.log", to: "appmonster:~/app.log", bytes: null },
        },
    ]);
    const cardOf = (line) => within(screen.getByText(line).closest(".vault-approval-card"));
    const upload = cardOf("Upload file · nas · admin@nas.example.net:2222");
    const fetchFile = cardOf("Fetch file · nas · admin@nas.example.net:2222");
    const session = { name: t("vault.approval.actions.session") };

    expect(upload.getByText("appmonster:~/build/app.tar.gz → nas:/volume1/deploy/app.tar.gz · 48.2 MB")).toBeInTheDocument();
    expect(upload.getByText(t("vault.approval.write"))).toBeInTheDocument();
    expect(upload.getByRole("button", session)).toBeInTheDocument();
    expect(fetchFile.getByText("nas:/volume1/logs/app.log → appmonster:~/app.log · size after approval")).toBeInTheDocument();
    expect(fetchFile.queryByText(t("vault.approval.write"))).toBeNull();
    expect(fetchFile.queryByRole("button", session)).toBeNull();
    expect(document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-EXEC']")).toBeNull();
    expect(document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-COMMAND']")).toBeNull();
    expect(document.querySelector("[data-ui-id='UI-VAULT-APPROVAL-HOSTKEY']")).toBeNull();
});

test("a host key mismatch notice shows a toast naming the target", async () => {
    mount();
    act(() => {
        stream.handlers[STATE_TYPES.VAULT_NOTICE]({ kind: "ssh_host_key_mismatch", item: "deploy-web", target: "server:12", name: "web02" });
    });

    expect(await screen.findByText("Host key of web02 changed — connection aborted")).toBeInTheDocument();
});

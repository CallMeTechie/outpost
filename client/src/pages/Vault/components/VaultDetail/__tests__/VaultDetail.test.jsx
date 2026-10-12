import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VaultDetail } from "@/pages/Vault/components/VaultDetail/VaultDetail.jsx";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
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

const node = (id) => document.querySelector(`[data-ui-id='${id}']`);
const detail = (shown) => <VaultDetail item={shown} impersonating={false} onEdit={() => {}} onDelete={() => {}} />;

test("die Nutzung durch Agenten nennt nur Eingeschaltetes, ohne Option den Leerzustand je Typ, und fehlt bei Login", () => {
    const { rerender } = show({
        ...item, id: 6, name: "github-pat", type: "api_key", secretFields: ["token"],
        fields: {
            hosts: ["api.github.com"], headerName: "Authorization", headerTemplate: "Bearer {{secret}}",
            readOnly: true, allowHttp: false, git: true, gitUsername: "x-access-token", fillOrigins: ["https://coolify.example.net"],
        },
    });
    expect(within(node("UI-VAULT-DETAIL-USAGE")).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
        "Read only", "Git · username x-access-token", "Fill in on https://coolify.example.net",
    ]);

    rerender(detail({ ...item, id: 6, name: "github-pat", type: "api_key", secretFields: ["token"], fields: { hosts: ["api.github.com"] } }));
    expect(within(node("UI-VAULT-DETAIL-USAGE")).queryAllByRole("listitem")).toEqual([]);
    expect(node("UI-VAULT-DETAIL-USAGE")).toHaveTextContent("vault_http over https");

    rerender(detail({ ...item, id: 7, name: "coolify-token", type: "generic", fields: { fillOrigins: [] }, secretFields: ["value"] }));
    expect(within(node("UI-VAULT-DETAIL-USAGE")).queryAllByRole("listitem")).toEqual([]);
    expect(node("UI-VAULT-DETAIL-USAGE")).toHaveTextContent("Manual use only — not filled in the browser");

    rerender(detail(item));
    expect(node("UI-VAULT-DETAIL-USAGE")).toBeNull();
});

const Servers = ({ children }) => (
    <ServerContext.Provider value={{ servers: [{ id: 12, type: "server", name: "web02", protocol: "ssh", ip: "192.168.2.40" }] }}>
        {children}
    </ServerContext.Provider>
);
const FINGERPRINT = "SHA256:3f9aT0qW8eLk2mN7vB1cX5zR4tY6uI9oP0aS3dFXc21";
const ssh = {
    ...item, id: 9, name: "deploy-web", type: "ssh", secretFields: ["privateKey"],
    fields: { username: "deploy", servers: [12], hosts: ["backup.example.net"], allowSession: true },
    hostKeys: [{
        target: "server:12", algorithm: "ssh-ed25519", fingerprint: FINGERPRINT,
        confirmedAt: "2026-10-11T10:00:00.000Z", confirmedBy: { id: 1, name: "Ada" },
    }],
};

test("SSH-Ziele zeigen den gemerkten Host-Key oder „noch nie verbunden“; Vergessen nur mit Reveal-Recht und ohne Impersonation, fragt nach, meldet einen Fehler und lädt nach dem zweiten Versuch die Liste neu; ohne Ziele der Leerzustand", async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    const sshDetail = (shown) => (
        <VaultDetail item={shown} impersonating={false} onEdit={() => {}} onDelete={() => {}} onHostKeyForgotten={reload} />
    );
    requestDouble.stub("deleteRequest", "vault/items/9/host-keys/server%3A12", Object.assign(new Error("boom"), { code: 500 }));
    const { rerender } = renderWithProviders(sshDetail(ssh), { providers: [ToastProvider, Servers] });
    const targets = within(node("UI-VAULT-DETAIL-SSH-TARGETS"));

    expect(targets.getByText("ED25519 SHA256:3f9aT0…Xc21")).toHaveAttribute("title", `ssh-ed25519 ${FINGERPRINT}`);
    const [web02, backup] = targets.getAllByRole("listitem");
    expect(web02).toHaveTextContent("web02");
    expect(web02).toHaveTextContent("deploy@192.168.2.40");
    expect(web02).toHaveTextContent(/confirmed .+ by Ada/);
    expect(backup).toHaveTextContent("deploy@backup.example.net:22");
    expect(backup).toHaveTextContent("never connected");
    expect(within(backup).queryByRole("button", { name: "Forget" })).toBeNull();
    expect(node("UI-VAULT-DETAIL-USAGE")).toHaveTextContent("Session approval allowed");

    await user.click(within(web02).getByRole("button", { name: "Forget" }));
    const confirm = targets.getByRole("alertdialog");
    expect(confirm).toHaveTextContent("Forget the stored host key of web02? The next connection asks again.");
    await user.click(within(confirm).getByRole("button", { name: "Forget" }));
    expect(await targets.findByRole("alert")).toHaveTextContent("Forgetting failed.");
    expect(web02).toHaveTextContent("ED25519");
    expect(reload).not.toHaveBeenCalled();

    requestDouble.stub("deleteRequest", "vault/items/9/host-keys/server%3A12", "");
    await user.click(within(web02).getByRole("button", { name: "Forget" }));
    await user.click(within(targets.getByRole("alertdialog")).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(targets.queryByRole("alert")).toBeNull();
    rerender(sshDetail({ ...ssh, canReveal: false }));
    expect(within(web02).queryByRole("button", { name: "Forget" })).toBeNull();
    rerender(<VaultDetail item={ssh} impersonating onEdit={() => {}} onDelete={() => {}} onHostKeyForgotten={reload} />);
    expect(within(web02).queryByRole("button", { name: "Forget" })).toBeNull();
    rerender(sshDetail({ ...ssh, hostKeys: [] }));
    expect(web02).toHaveTextContent("never connected");

    rerender(sshDetail({ ...ssh, id: 10, fields: { username: "deploy", servers: [], hosts: [], allowSession: false }, hostKeys: [] }));
    expect(node("UI-VAULT-DETAIL-SSH-TARGETS")).toHaveTextContent("No targets — add servers or hosts in the dialog.");
    expect(node("UI-VAULT-DETAIL-USAGE")).toHaveTextContent("Once only");
});

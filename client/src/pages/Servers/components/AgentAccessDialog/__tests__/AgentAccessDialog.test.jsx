import { beforeEach, expect, test, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import testI18n from "@/test/i18n.js";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";
import { ToastProvider } from "@/common/contexts/ToastContext.jsx";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { AgentAccessDialog } from "../AgentAccessDialog.jsx";

const requestDouble = await vi.hoisted(async () => {
    const { createRequestDouble } = await import("@/test/requestDouble.js");
    return createRequestDouble();
});
const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));

vi.mock("@/common/utils/RequestUtil.js", () => requestDouble.asModule());
vi.mock("@/common/utils/clipboard.js", () => clipboard);
const AVAILABLE = { canProvision: true, agentUrlSet: true, agentUrl: "http://192.168.2.10:6989", ipBindingDefault: true, trustProxyUnsafe: false, impersonating: false };
const vaultAvailable = vi.hoisted(() => ({ current: null }));
vi.mock("@/common/hooks/useVaultAvailable.js", () => ({ useVaultAvailable: () => vaultAvailable.current }));

const t = (key, options) => testI18n.t(key, options);

const servers = { getServerById: (id) => (Number(id) === 7 ? { id: 7, name: "web01", ip: "192.168.2.40", protocol: "ssh" } : null) };
const Servers = ({ children }) => <ServerContext.Provider value={servers}>{children}</ServerContext.Provider>;

const open = (onClose = () => {}) => renderWithProviders(
    <AgentAccessDialog open entryId={7} onClose={onClose} />,
    { providers: [ToastProvider, Servers] },
);

const node = (id) => document.querySelector(`[data-ui-id='${id}']`);

const runSetup = async (user, results) => {
    requestDouble.stub("postRequest", "vault/agent-keys", { results });
    await user.click(within(node("UI-AGENT-ACCESS-SETUP")).getByRole("button"));
    await within(node("UI-AGENT-ACCESS-RESULT")).findByText(t(`vault.agents.${results[0].agentType}`));
};

// DialogProvider calls onClose from onAnimationEnd, which jsdom never fires; React 19 listens
// under the vendor-prefixed name there, so the unprefixed animationEnd never reaches it.
const closeDialog = async (user) => {
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent(document.querySelector(".dialog"), new Event("webkitAnimationEnd", { bubbles: true }));
};

const manual = {
    id: 41, agentType: "codex", status: "manual", remoteUser: "root",
    command: "codex mcp add outpost --url http://192.168.2.10:6989/api/mcp --bearer-token-env-var OUTPOST_MCP_TOKEN",
    probe: null, replacedRegistration: false,
};

beforeEach(() => {
    vaultAvailable.current = AVAILABLE;
    requestDouble.reset();
    clipboard.copyToClipboard.mockReset();
    requestDouble.stub("getRequest", "vault/agent-keys?entryId=7", { keys: [], remoteUser: "root", otherAccountConfigured: false });
});

test("closing without copying or automatic setup deletes the pending key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    open(onClose);
    await runSetup(user, [manual]);
    requestDouble.stub("deleteRequest", "vault/agent-keys/41", { success: true });

    await closeDialog(user);

    expect(requestDouble.calls).toContainEqual({ method: "deleteRequest", path: "vault/agent-keys/41", body: undefined });
    expect(onClose).toHaveBeenCalled();
});

test("copying the command confirms the key, so closing afterwards deletes nothing", async () => {
    const user = userEvent.setup();
    clipboard.copyToClipboard.mockResolvedValue(true);
    const onClose = vi.fn();
    open(onClose);
    await runSetup(user, [manual]);
    requestDouble.stub("postRequest", "vault/agent-keys/41/confirm", { success: true });

    await user.click(within(node("UI-AGENT-ACCESS-RESULT")).getByRole("button", { name: t("servers.agentAccess.result.copy") }));

    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(manual.command);
    await waitFor(() => expect(requestDouble.calls).toContainEqual(
        { method: "postRequest", path: "vault/agent-keys/41/confirm", body: {} },
    ));
    await waitFor(() => expect(screen.queryByText(t("servers.agentAccess.result.keyNotice"))).not.toBeInTheDocument());

    await closeDialog(user);
    expect(onClose).toHaveBeenCalled();
    expect(requestDouble.calls.filter((call) => call.method === "deleteRequest")).toEqual([]);
});

test("a measured address that differs is offered for adoption and confirmed with addSeenIp", async () => {
    const user = userEvent.setup();
    open();
    await runSetup(user, [{
        id: 42, agentType: "claude", status: "configured", remoteUser: "root",
        probe: { seenIp: "172.17.0.1", matches: false }, replacedRegistration: false,
    }]);
    requestDouble.stub("postRequest", "vault/agent-keys/42/confirm", { success: true });

    expect(within(node("UI-AGENT-ACCESS-IPBIND")).getByText(
        t("servers.agentAccess.ipBind.seenOther", { seen: "172.17.0.1", expected: "192.168.2.40" }),
    )).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: t("servers.agentAccess.ipBind.adopt") }));

    await waitFor(() => expect(requestDouble.calls).toContainEqual(
        { method: "postRequest", path: "vault/agent-keys/42/confirm", body: { addSeenIp: true } },
    ));
});

test("revoking a key whose registration could not be removed shows the command to run on the server", async () => {
    const user = userEvent.setup();
    clipboard.copyToClipboard.mockResolvedValue(true);
    const commands = "codex mcp remove outpost";
    requestDouble.stub("getRequest", "vault/agent-keys?entryId=7", {
        keys: [{ id: 43, entryId: 7, agentType: "codex", pending: false, ipBinding: false, allowedCidrs: [],
            createdAt: "2026-10-09T08:00:00.000Z", lastUsedAt: null }],
        remoteUser: "root", otherAccountConfigured: false,
    });
    requestDouble.stub("deleteRequest", "vault/agent-keys/43", { success: true, registration: "unknown", commands });
    open();
    const keys = node("UI-AGENT-ACCESS-KEYS");

    await user.click(await within(keys).findByRole("button", { name: t("servers.agentAccess.keys.revoke") }));
    requestDouble.stub("getRequest", "vault/agent-keys?entryId=7", { keys: [], remoteUser: "root", otherAccountConfigured: false });
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: t("servers.agentAccess.keys.revoke") }));

    expect(await within(keys).findByText(t("servers.agentAccess.keys.empty"))).toBeInTheDocument();
    expect(within(keys).getByText(t("servers.agentAccess.keys.revokedUnknown"))).toBeInTheDocument();
    expect(within(keys).getByText(commands)).toBeInTheDocument();

    await user.click(within(keys).getByRole("button", { name: t("servers.agentAccess.result.copy") }));
    expect(clipboard.copyToClipboard).toHaveBeenCalledWith(commands);
});

test("the address of the server's last setup prefills the field and goes with the setup; an untouched binding is left to the server default", async () => {
    const user = userEvent.setup();
    vaultAvailable.current = { ...AVAILABLE, ipBindingDefault: false };
    requestDouble.stub("getRequest", "vault/agent-keys?entryId=7", {
        keys: [{ id: 44, entryId: 7, agentType: "claude", pending: false, ipBinding: false, allowedCidrs: [],
            agentUrl: "https://gate.example.net", createdAt: "2026-10-09T08:00:00.000Z", lastUsedAt: null }],
        remoteUser: "root", otherAccountConfigured: false,
    });
    open();
    const field = within(node("UI-AGENT-ACCESS-URL")).getByRole("textbox");
    const submit = within(node("UI-AGENT-ACCESS-SETUP")).getByRole("button");
    await waitFor(() => expect(field).toHaveValue("https://gate.example.net"));
    expect(within(node("UI-AGENT-ACCESS-IPBIND")).getByRole("checkbox")).not.toBeChecked();

    await user.clear(field);
    await user.type(field, "https://gate.example.net/?x=1");
    expect(submit).toBeDisabled();
    await user.clear(field);
    expect(within(node("UI-AGENT-ACCESS-URL")).getByText(t("servers.agentAccess.setup.urlMissing"))).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.type(field, "https://outpost.example.org");
    await runSetup(user, [{ id: 45, agentType: "claude", status: "configured", remoteUser: "root", probe: null, replacedRegistration: false }]);

    expect(requestDouble.calls).toContainEqual({
        method: "postRequest", path: "vault/agent-keys",
        body: { entryId: 7, agentTypes: ["claude", "codex"], agentUrl: "https://outpost.example.org", allowedCidrs: [] },
    });
});

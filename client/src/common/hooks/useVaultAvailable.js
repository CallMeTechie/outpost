import { useCallback, useContext, useEffect, useState } from "react";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { getRequest } from "@/common/utils/RequestUtil.js";

const UNAVAILABLE = Object.freeze({
    enabled: false, canUse: false, canManageOrgs: [], canProvision: false,
    agentUrlSet: false, agentUrl: null, ipBindingDefault: true, impersonating: false, trustProxyUnsafe: false,
});

const RETRY_MS = 30_000;

// Sidebar, mobile bar, quick action, the vault page and the server menu all mount this hook;
// they share one request per account, like loadBrowserAvailable.
let availability = { accountId: undefined, request: null };
const listeners = new Map();
const loadVaultAvailable = (accountId, force = false) => {
    if (force || availability.accountId !== accountId || !availability.request) {
        const request = getRequest("vault/available").then((answer) => ({ answer: { ...UNAVAILABLE, ...answer }, offline: false }), (error) => {
            console.debug("vault/available failed:", error);
            if (availability.request === request) availability = { accountId: undefined, request: null };
            return { answer: UNAVAILABLE, offline: error instanceof TypeError };
        });
        availability = { accountId, request };
    }
    return availability.request;
};

export const useVaultAvailable = () => {
    const { user } = useContext(UserContext);
    const accountId = user?.id;
    const [state, setState] = useState({ loading: true, ...UNAVAILABLE });

    useEffect(() => {
        if (!accountId) return;
        let active = true;
        let retry;
        const apply = (answer) => { if (active) setState({ loading: false, ...answer }); };
        if (!listeners.has(accountId)) listeners.set(accountId, new Set());
        const accountListeners = listeners.get(accountId);
        accountListeners.add(apply);
        loadVaultAvailable(accountId).then((result) => {
            apply(result.answer);
            if (active && result.offline) retry = setTimeout(() => loadVaultAvailable(accountId).then(({ answer }) => apply(answer)), RETRY_MS);
        });
        return () => {
            active = false;
            clearTimeout(retry);
            accountListeners.delete(apply);
            if (!accountListeners.size) listeners.delete(accountId);
        };
    }, [accountId]);

    const refresh = useCallback(async () => {
        if (!accountId) return;
        const { answer } = await loadVaultAvailable(accountId, true);
        for (const listener of listeners.get(accountId) ?? []) listener(answer);
    }, [accountId]);

    return { ...state, refresh };
};

import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { getSidebarNavigation } from "@/common/utils/navigationConfig.jsx";
import { getRequest } from "@/common/utils/RequestUtil.js";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";

// Sidebar, mobile bar and quick action all mount this hook; they share one request per account.
let availability = { accountId: undefined, request: null };
const loadBrowserAvailable = (accountId) => {
    if (availability.accountId !== accountId || !availability.request) {
        const request = getRequest("browser/available").then(({ enabled }) => enabled === true, (error) => {
            console.debug("browser/available failed:", error);
            if (availability.request === request) availability = { accountId: undefined, request: null };
            return false;
        });
        availability = { accountId, request };
    }
    return availability.request;
};

// The browser entry also depends on an admin setting the client cannot read, hence the extra request.
export const useSidebarNavigation = () => {
    const { t } = useTranslation();
    const { user, hasPermission } = useContext(UserContext);
    const [browserAvailable, setBrowserAvailable] = useState(false);
    const { canUse: vaultCanUse } = useVaultAvailable();

    useEffect(() => {
        if (!user?.id) return;
        let active = true;
        loadBrowserAvailable(user.id).then((enabled) => { if (active) setBrowserAvailable(enabled); });
        return () => { active = false; };
    }, [user?.id]);

    // QuickAction memoizes on this list; a new array every render would reset its selection.
    return useMemo(() => getSidebarNavigation(t).filter(item => (!item.permission || hasPermission(item.permission))
        && (item.key !== "browser" || browserAvailable)
        && (item.key !== "vault" || vaultCanUse)), [t, hasPermission, browserAvailable, vaultCanUse]);
};

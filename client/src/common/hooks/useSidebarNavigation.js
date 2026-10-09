import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { getSidebarNavigation } from "@/common/utils/navigationConfig.jsx";
import { getRequest } from "@/common/utils/RequestUtil.js";

// The browser entry also depends on an admin setting the client cannot read, hence the extra request.
export const useSidebarNavigation = () => {
    const { t } = useTranslation();
    const { hasPermission } = useContext(UserContext);
    const [browserAvailable, setBrowserAvailable] = useState(false);

    useEffect(() => {
        let active = true;
        getRequest("browser/available")
            .then(({ enabled }) => { if (active) setBrowserAvailable(enabled === true); })
            .catch(() => {});
        return () => { active = false; };
    }, []);

    return getSidebarNavigation(t).filter(item => (!item.permission || hasPermission(item.permission))
        && (item.key !== "browser" || browserAvailable));
};

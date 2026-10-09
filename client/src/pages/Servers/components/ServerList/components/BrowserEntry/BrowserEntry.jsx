import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import { Globe as IconGlobe } from "lucide-react";
import { getRequest } from "@/common/utils/RequestUtil.js";
import "./styles.sass";

export const BrowserEntry = ({ openBrowser }) => {
    const { t } = useTranslation();
    const [enabled, setEnabled] = useState(false);

    useEffect(() => {
        getRequest("browser/available")
            .then(({ enabled }) => setEnabled(enabled === true))
            .catch(error => console.error("Failed to load browser availability:", error));
    }, []);

    if (!enabled) return null;

    return (
        <div className="browser-entry">
            <div className="browser-entry-item" onClick={() => openBrowser?.()}>
                <Icon icon={IconGlobe} />
                <span className="browser-entry-name">{t("servers.browserEntry")}</span>
            </div>
        </div>
    );
};

export default BrowserEntry;

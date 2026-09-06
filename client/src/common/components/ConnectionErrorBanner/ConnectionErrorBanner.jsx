import { useContext } from "react";
import { StateStreamContext } from "@/common/contexts/StateStreamContext.jsx";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import Icon from "@/common/components/Icon";
import { CircleAlert as IconCircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./styles.sass";

export const ConnectionErrorBanner = () => {
    const { connectionError } = useContext(StateStreamContext);
    const { sessionToken } = useContext(UserContext);
    const { t } = useTranslation();

    if (!sessionToken || !connectionError) return null;

    return (
        <div className="connection-error-banner">
            <Icon icon={IconCircleAlert} className="banner-icon" />
            <div className="banner-content">
                <span className="banner-title">{t("common.errors.webSocketConnection.title")}</span>
                <span className="banner-description">
                    {t("common.errors.webSocketConnection.message")}
                </span>
            </div>
        </div>
    );
};
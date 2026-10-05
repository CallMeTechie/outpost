import { memo } from "react";
import Icon from "@/common/components/Icon";
import { Laptop as IconLaptop, Server as IconServer, X as IconX, CircleAlert as IconCircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./styles.sass";

export const ConnectionError = memo(({ message, onClose }) => {
    const { t } = useTranslation();

    return (
        <div className="connection-error">
            <div className="connection-error__bar" />
            <div className="connection-error__visual">
                <div className="connection-error__device">
                    <Icon icon={IconLaptop} className="connection-error__device-icon" />
                </div>
                <div className="connection-error__link">
                    <span className="connection-error__link-line" />
                    <span className="connection-error__link-badge">
                        <Icon icon={IconCircleAlert} />
                    </span>
                    <span className="connection-error__link-line" />
                </div>
                <div className="connection-error__device connection-error__device--server">
                    <Icon icon={IconServer} className="connection-error__device-icon" />
                </div>
            </div>
            <div className="connection-error__text">
                <h2 className="connection-error__title">{t("common.errors.connection.title")}</h2>
                <p className="connection-error__message">{message}</p>
            </div>
            {onClose && (
                <button type="button" className="connection-error__action" onClick={onClose}>
                    <Icon icon={IconX} />
                    <span>{t("common.errors.connection.close")}</span>
                </button>
            )}
        </div>
    );
});
ConnectionError.displayName = "ConnectionError";

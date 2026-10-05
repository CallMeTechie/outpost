import { memo } from "react";
import Icon from "@/common/components/Icon";
import Button from "@/common/components/Button";
import { Laptop as IconLaptop, Server as IconServer, X as IconX, CircleAlert as IconCircleAlert, RotateCw as IconRotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./styles.sass";

const stateOf = ({ expired, reconnecting, reconnect, now, retryable }) => {
    if (expired) return "expired";
    if (reconnecting) return "loading";
    if (reconnect) return Number.isFinite(now) ? "countdown" : "default";
    return retryable ? "default" : "final";
};

export const ConnectionError = memo(({ message, retryable = false, expired = false, reconnecting = false, reconnect = null, now = null, reconnectable = true, onReconnect, onClose }) => {
    const { t } = useTranslation();
    const state = stateOf({ expired, reconnecting, reconnect, now, retryable });

    const title = state === "expired" ? t("common.errors.connection.expiredTitle")
        : state === "final" ? t("common.errors.connection.title")
        : t("common.errors.connection.lostTitle");
    const text = state === "expired" ? t("common.errors.connection.expired")
        : state === "loading" ? t("common.errors.connection.reconnecting")
        : message;
    const seconds = state === "countdown" ? Math.max(0, Math.ceil((reconnect.nextAttemptAt - now) / 1000)) : 0;

    return (
        <div className="connection-error" data-ui-id="UI-SERVERS-VIEW-ERROR" data-ui-state={state} role="alert">
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
                <h2 className="connection-error__title">{title}</h2>
                <p className="connection-error__message">{text}</p>
                {state === "countdown" && (
                    <p className="connection-error__countdown">
                        {t("common.errors.connection.countdown", { seconds, attempt: reconnect.attempt, max: reconnect.maxAttempts })}
                    </p>
                )}
            </div>
            <div className="connection-error__actions">
                {onReconnect && state !== "expired" && reconnectable !== false && (
                    <Button type="primary" icon={IconRotateCw}
                            text={t(state === "countdown" ? "common.errors.connection.reconnectNow" : "common.errors.connection.reconnect")}
                            onClick={onReconnect} loading={state === "loading"} disabled={state === "loading"} />
                )}
                {onClose && (
                    <Button type="secondary" icon={IconX} text={t("common.close")} onClick={onClose} />
                )}
            </div>
        </div>
    );
});
ConnectionError.displayName = "ConnectionError";

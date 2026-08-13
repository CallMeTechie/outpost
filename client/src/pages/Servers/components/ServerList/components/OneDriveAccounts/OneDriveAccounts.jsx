import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiMicrosoft, mdiAlertCircleOutline } from "@mdi/js";
import { getRequest } from "@/common/utils/RequestUtil.js";
import "./styles.sass";

export const OneDriveAccounts = ({ openOneDrive }) => {
    const { t } = useTranslation();
    const [connections, setConnections] = useState([]);

    // Attaching .then() directly to the request, instead of routing it through a named
    // async function invoked from the effect, is how the rest of this codebase fetches
    // on mount without setState firing synchronously inside the effect body.
    useEffect(() => {
        getRequest("microsoft/connections")
            .then(setConnections)
            .catch(error => console.error("Failed to load Microsoft connections:", error));
    }, []);

    if (connections.length === 0) return null;

    return (
        <div className="onedrive-accounts">
            <div className="onedrive-accounts-title">{t("servers.oneDrive.sectionTitle")}</div>
            {connections.map(connection => {
                const connected = connection.status === "connected";
                return (
                    <div key={connection.id}
                         className={`onedrive-account${connected ? "" : " is-disconnected"}`}
                         title={connected ? connection.microsoftEmail : t("servers.oneDrive.reconnectHint")}
                         onClick={() => connected && openOneDrive?.(connection)}>
                        <Icon path={connected ? mdiMicrosoft : mdiAlertCircleOutline} />
                        <span className="onedrive-account-name">{connection.displayName}</span>
                        {!connected && <span className="onedrive-account-state">{t("servers.oneDrive.disconnected")}</span>}
                    </div>
                );
            })}
        </div>
    );
};

export default OneDriveAccounts;

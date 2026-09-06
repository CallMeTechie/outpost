import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import { Pencil as IconPencil, Trash as IconTrash, CircleAlert as IconCircleAlert } from "lucide-react";
import { mdiMicrosoft } from "@mdi/js";
import Button from "@/common/components/Button";
import Checkbox from "@/common/components/Checkbox";
import ActionConfirmDialog from "@/common/components/ActionConfirmDialog";
import { deleteRequest, getRequest, patchRequest, postRequest } from "@/common/utils/RequestUtil.js";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import "./styles.sass";

const MESSAGE_TYPE = "outpost:microsoft";

export const MicrosoftConnections = () => {
    const { t } = useTranslation();
    const { sendToast } = useToast();

    const [connections, setConnections] = useState([]);
    const [allFiles, setAllFiles] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [editingName, setEditingName] = useState("");
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [toDelete, setToDelete] = useState(null);

    const popupWatchRef = useRef(null);
    const cancelledRenameRef = useRef(false);

    const stopWatchingPopup = useCallback(() => {
        if (popupWatchRef.current === null) return;
        clearInterval(popupWatchRef.current);
        popupWatchRef.current = null;
    }, []);

    useEffect(() => stopWatchingPopup, [stopWatchingPopup]);

    const load = useCallback(async () => {
        try {
            setConnections(await getRequest("microsoft/connections"));
        } catch (error) {
            console.error("Failed to load Microsoft connections:", error);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        const onMessage = (event) => {
            // The popup runs on this origin; anything else is not ours to trust.
            if (event.origin !== window.location.origin) return;
            if (event.data?.type !== MESSAGE_TYPE) return;

            stopWatchingPopup();
            setConnecting(false);

            if (event.data.status === "connected") {
                sendToast(t("common.success"), t("settings.account.microsoft.connected"));
                load();
                return;
            }

            const reason = event.data.reason || "authorize_failed";
            sendToast(t("common.error"), t(`settings.account.microsoft.errors.${reason}`));
        };

        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [load, sendToast, stopWatchingPopup, t]);

    const connect = async () => {
        setConnecting(true);
        try {
            const { url } = await postRequest("microsoft/connections/start", { allFiles });
            const popup = window.open(url, "outpost-microsoft", "width=600,height=760");

            if (!popup) {
                setConnecting(false);
                sendToast(t("common.error"), t("settings.account.microsoft.popupBlocked"));
                return;
            }

            // The pop-up reports back by posting a message. A user who simply closes the window sends
            // nothing at all — without this watch the button would stay disabled until the page is
            // reloaded. `closed` is readable across origins; nothing else about the window is.
            stopWatchingPopup();
            popupWatchRef.current = setInterval(() => {
                if (!popup.closed) return;
                stopWatchingPopup();
                setConnecting(false);
            }, 500);
        } catch (error) {
            setConnecting(false);
            sendToast(t("common.error"), error.message || t("settings.account.microsoft.disabled"));
        }
    };

    const saveName = async () => {
        // Escape sets this. Whether removing the focused input fires a blur is browser-dependent, so
        // the cancellation is recorded in a ref rather than left to depend on that.
        if (cancelledRenameRef.current) {
            cancelledRenameRef.current = false;
            return;
        }

        const name = editingName.trim();
        if (!name) return setEditingId(null);

        try {
            await patchRequest(`microsoft/connections/${editingId}`, { displayName: name });
            load();
        } catch (error) {
            sendToast(t("common.error"), error.message);
        }
        setEditingId(null);
    };

    const confirmDelete = (connection) => {
        setToDelete(connection);
        setDeleteOpen(true);
    };

    const remove = async () => {
        if (!toDelete) return;

        try {
            await deleteRequest(`microsoft/connections/${toDelete.id}`);
            load();
        } catch (error) {
            sendToast(t("common.error"), error.message);
        }
        setToDelete(null);
    };

    return (
        <div className="account-section">
            <ActionConfirmDialog open={deleteOpen} setOpen={setDeleteOpen} onConfirm={remove}
                                 text={t("settings.account.microsoft.confirmDisconnect")} />

            <div className="section-header">
                <div className="header-content">
                    <h2><Icon icon={mdiMicrosoft} size={0.8} style={{ marginRight: "8px" }} />
                        {t("settings.account.microsoft.sectionTitle")}</h2>
                    <p>{t("settings.account.microsoft.sectionDescription")}</p>
                </div>
                <Button text={t("settings.account.microsoft.connectButton")} icon={mdiMicrosoft}
                        disabled={connecting} onClick={connect} />
            </div>

            <div className="ms-scope-choice">
                <Checkbox id="ms-all-files" checked={allFiles} onChange={setAllFiles} />
                <label htmlFor="ms-all-files">
                    <span>{t("settings.account.microsoft.allFilesLabel")}</span>
                    <small>{t("settings.account.microsoft.allFilesHint")}</small>
                </label>
            </div>
            <p className="ms-scope-note">{t("settings.account.microsoft.scopeNote")}</p>

            <div className="settings-list">
                {connections.length > 0 ? connections.map(connection => (
                    <div className="settings-list-item" key={connection.id}>
                        <div className="item-info">
                            <Icon icon={mdiMicrosoft} className="item-icon" />
                            <div className="item-details">
                                {editingId === connection.id ? (
                                    <input type="text" value={editingName} autoFocus className="ms-name-input"
                                           onChange={(e) => setEditingName(e.target.value)}
                                           onBlur={saveName}
                                           onKeyDown={(e) => {
                                               if (e.key === "Enter") saveName();
                                               if (e.key === "Escape") { cancelledRenameRef.current = true; setEditingId(null); }
                                           }} />
                                ) : <h3>{connection.displayName}</h3>}

                                <p className="item-meta ms-connection-meta">
                                    <span>{connection.microsoftEmail}</span>
                                    <span className={connection.status === "connected" ? "ms-ok" : "ms-dead"}>
                                        {connection.status === "connected"
                                            ? t("settings.account.microsoft.statusConnected")
                                            : t("settings.account.microsoft.statusDisconnected")}
                                    </span>
                                    {connection.hasAllFilesAccess &&
                                        <span>{t("settings.account.microsoft.allFilesGranted")}</span>}
                                    <span>
                                        {connection.lastRefreshAt
                                            ? t("settings.account.microsoft.lastRefresh", {
                                                date: new Date(connection.lastRefreshAt).toLocaleString(),
                                                interpolation: { escapeValue: false },
                                            })
                                            : t("settings.account.microsoft.neverRefreshed")}
                                    </span>
                                </p>
                            </div>
                        </div>
                        <div className="item-actions">
                            {connection.status !== "connected" &&
                                <Icon icon={IconCircleAlert} size={0.8} className="ms-dead-icon" />}
                            <button className="action-btn edit-btn"
                                    title={t("settings.account.microsoft.rename")}
                                    onClick={() => {
                                        setEditingId(connection.id);
                                        setEditingName(connection.displayName);
                                        // An Escape that was never followed by a blur would leave
                                        // the flag set and silently swallow this rename instead.
                                        // Clearing it where an edit begins removes the dependency
                                        // on a blur firing at all.
                                        cancelledRenameRef.current = false;
                                    }}>
                                <Icon icon={IconPencil} size={0.8} />
                            </button>
                            <button className="action-btn delete-btn"
                                    title={t("settings.account.microsoft.disconnect")}
                                    onClick={() => confirmDelete(connection)}>
                                <Icon icon={IconTrash} size={0.8} />
                            </button>
                        </div>
                    </div>
                )) : (
                    <div className="list-empty">
                        <p>{t("settings.account.microsoft.noConnections")}</p>
                    </div>
                )}
            </div>
        </div>
    );
};

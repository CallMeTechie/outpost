import "./styles.sass";
import { useContext, useEffect, useState } from "react";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { mdiConnection, mdiFolderOpen, mdiCursorDefaultClick } from "@mdi/js";
import { getRequest } from "@/common/utils/RequestUtil";
import { useTranslation } from "react-i18next";
import { ContextMenu, ContextMenuItem, useContextMenu } from "@/common/components/ContextMenu";
import { formatTimeAgo } from "@/common/utils/timeAgo.js";
import DownloadAppsDialog from "@/common/components/DownloadAppsDialog";
import { DeviceLinkDialog } from "@/common/components/DeviceLinkDialog/DeviceLinkDialog.jsx";

const PROTOCOL_LABELS = {
    "entry.ssh_connect": "SSH", "entry.sftp_connect": "SFTP", "entry.rdp_connect": "RDP",
    "entry.vnc_connect": "VNC",
    "entry.demo_connect": "Demo", "entry.pve_connect": "PVE",
};

export const WelcomePanel = ({
                                 connectToServer,
                                 hibernatedSessions = [],
                                 resumeSession,
                                 openSFTP,
                                 openDirectConnect,
                                 onCreateServer,
                             }) => {
    const { getServerById } = useContext(ServerContext);
    const { t } = useTranslation();
    const [recentConnections, setRecentConnections] = useState([]);
    const [loading, setLoading] = useState(true);
    const [contextItem, setContextItem] = useState(null);
    const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
    const [deviceLinkDialogOpen, setDeviceLinkDialogOpen] = useState(false);
    const contextMenu = useContextMenu();

    useEffect(() => {
        getRequest("/entries/recent?limit=5").then(data => setRecentConnections(data || [])).catch(() => {
        }).finally(() => setLoading(false));
    }, []);

    const server = contextItem ? getServerById(contextItem.entryId) : null;
    const getHibernated = (entryId) => hibernatedSessions.find(s => s.server?.id === entryId);

    const handleClick = (item) => {
        const hibernated = getHibernated(item.entryId);
        if (hibernated) resumeSession(hibernated.id);
        else connectToServer(item.entryId, item.identities?.[0] ? { id: item.identities[0] } : null);
    };

    const handleContextMenu = (e, item) => {
        e.preventDefault();
        setContextItem(item);
        contextMenu.open(e, { x: e.clientX, y: e.clientY });
    };

    const connect = () => {
        if (server) {
            connectToServer(server.id, server.identities?.[0] ? { id: server.identities[0] } : null);
            contextMenu.close();
        }
    };
    const connectSftp = () => {
        if (server && openSFTP) {
            openSFTP(server.id, server.identities?.[0] ? { id: server.identities[0] } : null);
            contextMenu.close();
        }
    };
    const quickConnect = () => {
        if (server && openDirectConnect) {
            openDirectConnect(server);
            contextMenu.close();
        }
    };

    // The artboard's "Weiter" column (.starts): one line per way in, each with a title, a line
    // saying what it does, and its position as the accelerator. Built from the actions that
    // actually exist rather than from the artboard's three, so nothing loses its entry point --
    // the artboard folds device linking and direct connect into one line, but they are two
    // different dialogs here.
    const starts = [
        onCreateServer && {
            key: "create",
            title: t("welcome.getStarted"),
            description: t("welcome.starts.createDescription"),
            onClick: () => onCreateServer(),
        },
        openDirectConnect && {
            key: "direct",
            title: t("servers.contextMenu.quickConnect"),
            description: t("welcome.starts.directDescription"),
            onClick: () => openDirectConnect(),
        },
        {
            key: "device",
            title: t("welcome.connectDevice"),
            description: t("welcome.starts.deviceDescription"),
            onClick: () => setDeviceLinkDialogOpen(true),
        },
        {
            key: "apps",
            title: t("welcome.downloadApps"),
            description: t("welcome.starts.appsDescription"),
            onClick: () => setDownloadDialogOpen(true),
        },
    ].filter(Boolean);

    return (
        <div className="welcome-panel" data-ui-id="UI-SERVERS-WELCOME">
            <div className="welcome">
                <h3>
                    {t("welcome.title")}
                    <small>{t("welcome.tagline")}</small>
                </h3>

                <div className="welcome-column">
                    <h4>{t("welcome.recentConnections")}</h4>
                    {loading ? (
                        <ul className="recent" aria-busy="true">
                            {[0, 1, 2].map((i) => <li key={i} className="skeleton"><i /></li>)}
                        </ul>
                    ) : recentConnections.length > 0 ? (
                        <ul className="recent">
                            {recentConnections.map((item, i) => {
                                const hibernated = getHibernated(item.entryId);
                                const protocol = PROTOCOL_LABELS[item.connectionType];
                                const when = hibernated ? t("welcome.hibernated") : formatTimeAgo(item.timestamp, t);
                                return (
                                    <li key={`${item.entryId}-${i}`}
                                        className={hibernated ? "hibernated" : undefined}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => handleClick(item)}
                                        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), handleClick(item))}
                                        onContextMenu={(e) => handleContextMenu(e, item)}>
                                        <span className="n">{item.name}</span>
                                        <span className="m">{[protocol, when].filter(Boolean).join(" · ")}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className="welcome-empty">{t("welcome.noRecent")}</p>
                    )}
                </div>

                <div className="welcome-column">
                    <h4>{t("welcome.next")}</h4>
                    <ul className="starts">
                        {starts.map((start, index) => (
                            <li key={start.key} role="button" tabIndex={0}
                                onClick={start.onClick}
                                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), start.onClick())}>
                                <span>
                                    <span className="t">{start.title}</span>
                                    <span className="s">{start.description}</span>
                                </span>
                                <kbd>{index + 1}</kbd>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>

            <ContextMenu isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={contextMenu.close}
                         trigger={contextMenu.triggerRef}>
                {server && (
                    <>
                        <ContextMenuItem icon={mdiConnection} label={t("servers.contextMenu.connect")}
                                         shortcut="Enter" onClick={connect} />
                        {server.protocol === "ssh" && openSFTP && (
                            <ContextMenuItem icon={mdiFolderOpen} label={t("servers.contextMenu.openSFTP")}
                                             shortcut="Shift+Enter" onClick={connectSftp} />
                        )}
                        {openDirectConnect && (
                            <ContextMenuItem icon={mdiCursorDefaultClick} label={t("servers.contextMenu.quickConnect")}
                                             onClick={quickConnect} />
                        )}
                    </>
                )}
            </ContextMenu>

            <DownloadAppsDialog open={downloadDialogOpen} onClose={() => setDownloadDialogOpen(false)} />
            <DeviceLinkDialog open={deviceLinkDialogOpen} onClose={() => setDeviceLinkDialogOpen(false)} />
        </div>
    );
};

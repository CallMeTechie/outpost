import "./styles.sass";
import { useContext, useEffect, useState } from "react";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useLiveSessions } from "@/common/contexts/LiveSessionContext.jsx";
import { mdiConnection, mdiFolderOpen, mdiCursorDefaultClick } from "@mdi/js";
import { getRequest } from "@/common/utils/RequestUtil";
import { useTranslation } from "react-i18next";
import { ContextMenu, ContextMenuItem, useContextMenu } from "@/common/components/ContextMenu";
import { formatTimeAgo } from "@/common/utils/timeAgo.js";
import { getAvatarLabel } from "@/common/utils/avatar.js";
import { entryColorFor } from "../ViewContainer/utils/paneColors.js";
import DownloadAppsDialog from "@/common/components/DownloadAppsDialog";
import { DeviceLinkDialog } from "@/common/components/DeviceLinkDialog/DeviceLinkDialog.jsx";

const PROTOCOL_LABELS = {
    "entry.ssh_connect": "SSH", "entry.sftp_connect": "SFTP", "entry.rdp_connect": "RDP",
    "entry.vnc_connect": "VNC",
    "entry.demo_connect": "Demo", "entry.pve_connect": "PVE",
};

// Which greeting the hour falls under. Boundaries are the everyday ones, not astronomical:
// the point is that the screen sounds like it noticed when you sat down.
const greetingKey = (hour) => {
    if (hour < 11) return "welcome.greeting.morning";
    if (hour < 18) return "welcome.greeting.afternoon";
    return "welcome.greeting.evening";
};

export const WelcomePanel = ({
                                 connectToServer,
                                 hibernatedSessions = [],
                                 resumeSession,
                                 openSFTP,
                                 openDirectConnect,
                                 onCreateServer,
                                 onImportSSHConfig,
                             }) => {
    const { user } = useContext(UserContext);
    const { getServerById } = useContext(ServerContext);
    const { getLiveSessionsForEntry } = useLiveSessions();
    const { t } = useTranslation();
    const [recentConnections, setRecentConnections] = useState([]);
    const [loading, setLoading] = useState(true);
    const [contextItem, setContextItem] = useState(null);
    const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
    const [deviceLinkDialogOpen, setDeviceLinkDialogOpen] = useState(false);
    const contextMenu = useContextMenu();

    // Six, because the grid is three wide and two rows is what fits above the fold.
    useEffect(() => {
        getRequest("/entries/recent?limit=6").then(data => setRecentConnections(data || [])).catch(() => {
        }).finally(() => setLoading(false));
    }, []);

    const server = contextItem ? getServerById(contextItem.entryId) : null;
    const getHibernated = (entryId) => hibernatedSessions.find(s => s.server?.id === entryId);

    // Pinned once when the panel mounts, not read per render: every card on one screen then
    // agrees about what "12 minutes ago" means, and the render body stays pure -- reading the
    // clock during render makes the output depend on when React happens to re-render.
    const [now] = useState(() => Date.now());
    const greeting = t(greetingKey(new Date(now).getHours()));
    const name = getAvatarLabel(user, t("welcome.defaultName"));

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

    // The artboard's .ways row. Small and in one line: after the first day nobody needs them
    // prominent, but every one of them has to stay reachable -- this screen is the only place
    // some of these dialogs can be opened from.
    const hasTargets = recentConnections.length > 0;
    const ways = [
        openDirectConnect && { key: "direct", label: t("servers.contextMenu.quickConnect"),
            primary: hasTargets, onClick: () => openDirectConnect() },
        onCreateServer && { key: "create", label: t("welcome.emptyCreate"),
            primary: !hasTargets, onClick: () => onCreateServer() },
        onImportSSHConfig && { key: "import", label: t("servers.contextMenu.import"),
            onClick: () => onImportSSHConfig() },
        { key: "device", label: t("welcome.connectDevice"), onClick: () => setDeviceLinkDialogOpen(true) },
        { key: "apps", label: t("welcome.downloadApps"), onClick: () => setDownloadDialogOpen(true) },
    ].filter(Boolean);

    return (
        <div className="welcome-panel" data-ui-id="UI-SERVERS-WELCOME">
            <div className="welcome">
                <h3>
                    {greeting}, {name}.{" "}
                    <span>{loading || hasTargets ? t("welcome.whereNext") : t("welcome.noneYet")}</span>
                </h3>

                {loading ? (
                    <div className="targets" aria-busy="true">
                        {[0, 1, 2].map((i) => <div key={i} className="card skeleton" />)}
                    </div>
                ) : hasTargets ? (
                    <div className="targets">
                        {recentConnections.map((item, i) => {
                            const hibernated = getHibernated(item.entryId);
                            // The same meaning the list's dot carries: something is running on
                            // this entry right now. /entries/recent returns no reachability
                            // field, and a hibernated session is parked, not connected -- so
                            // neither of those may light it.
                            const online = getLiveSessionsForEntry(item.entryId).length > 0;
                            return (
                                <div key={`${item.entryId}-${i}`}
                                     className={`card${hibernated ? " sleeping" : ""}`}
                                     style={{ "--pane": entryColorFor(item.entryId) }}
                                     role="button"
                                     tabIndex={0}
                                     title={item.name}
                                     onClick={() => handleClick(item)}
                                     onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), handleClick(item))}
                                     onContextMenu={(e) => handleContextMenu(e, item)}>
                                    <div className="top">
                                        <span className={`dot${online ? " on" : ""}`} />
                                        <span className="host">{item.name}</span>
                                        <span className="kind">{PROTOCOL_LABELS[item.connectionType] || ""}</span>
                                    </div>
                                    <span className="when">
                                        {hibernated ? t("welcome.resume") : formatTimeAgo(item.timestamp, t, now)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="welcome-empty">{t("welcome.emptyHint")}</p>
                )}

                <div className="ways">
                    {ways.map((way) => (
                        <button key={way.key} type="button"
                                className={`w${way.primary ? " primary" : ""}`}
                                onClick={way.onClick}>
                            {way.label}
                        </button>
                    ))}
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

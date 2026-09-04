import "./styles.sass";
import { useContext, useEffect, useState } from "react";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import Icon from "@mdi/react";
import { mdiHistory, mdiPlay, mdiPower, mdiServerNetwork, mdiServerPlus, mdiConnection, mdiFolderOpen,
    mdiCursorDefaultClick, mdiDownload, mdiLinkVariant } from "@mdi/js";
import { getRequest } from "@/common/utils/RequestUtil";
import { useTranslation } from "react-i18next";
import { ContextMenu, ContextMenuItem, useContextMenu } from "@/common/components/ContextMenu";
import { getIconPath } from "@/common/utils/iconUtils.js";
import { formatTimeAgo } from "@/common/utils/timeAgo.js";
import { getAvatarLabel } from "@/common/utils/avatar.js";
import { entryColorFor } from "../ViewContainer/utils/paneColors.js";
import Button from "@/common/components/Button";
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
    const { user } = useContext(UserContext);
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

    // Pinned at mount rather than read per render: every row on one screen then agrees about
    // what "12 minutes ago" means, and the render body stays pure.
    const [now] = useState(() => Date.now());

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

    const header = (
        <div className="section-header">
            <Icon path={mdiHistory} />
            <h3>{t("welcome.recentConnections")}</h3>
        </div>
    );

    return (
        <div className="welcome-panel" data-ui-id="UI-SERVERS-WELCOME">
            <div className="welcome-left">
                <h1>{t("welcome.hello")}, <span>{getAvatarLabel(user, t("welcome.defaultName"))}</span>!</h1>
                {/* What to do next, not what the product is: whoever reads this is already inside
                    it. The old line -- "the open-source server manager for SSH, VNC and RDP" --
                    was written for a visitor. */}
                <p>{t("welcome.lead")}</p>
                <div className="welcome-buttons">
                    {openDirectConnect && (
                        <Button icon={mdiCursorDefaultClick} text={t("servers.contextMenu.quickConnect")}
                                onClick={() => openDirectConnect()} />
                    )}
                    {onCreateServer && (
                        <Button type="secondary" icon={mdiServerPlus} text={t("servers.emptyCreate")}
                                onClick={() => onCreateServer()} />
                    )}
                    {/* Kept although the artboard shows three buttons: the /link route this opens
                        has no navigation entry anywhere, so this is its one findable way in. */}
                    <Button type="secondary" icon={mdiLinkVariant} text={t("welcome.connectDevice")}
                            onClick={() => setDeviceLinkDialogOpen(true)} />
                    <Button type="secondary" icon={mdiDownload} text={t("welcome.downloadApps")}
                            onClick={() => setDownloadDialogOpen(true)} />
                </div>
            </div>

            <div className="welcome-right">
                {loading ? (
                    <div className="recent-connections">
                        {header}
                        {/* Placeholder rows rather than a spinner, so the column keeps its height
                            and nothing jumps when the answer arrives. */}
                        <div className="recent-list" aria-busy="true">
                            {[0, 1, 2].map((i) => <div key={i} className="recent-item skeleton" />)}
                        </div>
                    </div>
                ) : recentConnections.length > 0 ? (
                    <div className="recent-connections">
                        {header}
                        <div className="recent-list">
                            {recentConnections.map((item, i) => {
                                const hibernated = getHibernated(item.entryId);
                                const protocol = PROTOCOL_LABELS[item.connectionType];
                                return (
                                    <div key={`${item.entryId}-${i}`}
                                         className={`recent-item${hibernated ? " hibernated" : ""}`}
                                         role="button"
                                         tabIndex={0}
                                         onClick={() => handleClick(item)}
                                         onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), handleClick(item))}
                                         onContextMenu={(e) => handleContextMenu(e, item)}>
                                        {/* One colour per target, derived from the entry id. It was
                                            $primary on every row before and therefore said nothing
                                            about which server you were looking at. */}
                                        <div className="item-icon" style={{ backgroundColor: entryColorFor(item.entryId) }}>
                                            <Icon path={getIconPath(item.icon)} />
                                        </div>
                                        <div className="item-info">
                                            <span className="item-name">{item.name}</span>
                                            <span className="item-meta">
                                                {hibernated ? (
                                                    <span className="hibernated-badge">
                                                        <Icon path={mdiPower} />{t("welcome.resume")}
                                                    </span>
                                                ) : formatTimeAgo(item.timestamp, t, now)}
                                            </span>
                                        </div>
                                        <div className="item-action">
                                            {protocol && <span className="protocol-badge">{protocol}</span>}
                                            <Icon path={mdiPlay} className="play-icon" />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : (
                    <div className="empty-state">
                        <Icon path={mdiServerNetwork} />
                        <h3>{t("welcome.getStarted")}</h3>
                        <p>{t("welcome.emptyHint")}</p>
                    </div>
                )}
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

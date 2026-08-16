import { useRef, useState, useEffect, useCallback, useContext } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiClose, mdiViewSplitVertical, mdiChevronLeft, mdiChevronRight, mdiSleep, mdiOpenInNew, mdiShareVariant, mdiLinkVariant, mdiPencil, mdiEye, mdiCloseCircle, mdiContentDuplicate, mdiNoteEditOutline, mdiMicrosoft, mdiRenameBox } from "@mdi/js";
import { useDrag, useDrop } from "react-dnd";
import TerminalActionsMenu from "../TerminalActionsMenu";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, useContextMenu } from "@/common/components/ContextMenu";
import { useActiveSessions } from "@/common/contexts/SessionContext.jsx";
import { useLiveSessions } from "@/common/contexts/LiveSessionContext.jsx";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import AvatarStack from "@/common/components/AvatarStack";
import { postRequest, deleteRequest, patchRequest } from "@/common/utils/RequestUtil";
import { getBaseUrl } from "@/common/utils/ConnectionUtil.js";
import { getIconPath } from "@/common/utils/iconUtils.js";
import { paneColorFor } from "../../utils/paneColors.js";
import { buildTabLabel } from "@/common/utils/tabLabel.js";
import RenameTabDialog from "./RenameTabDialog.jsx";
import "./styles.sass";

const DraggableTab = ({
    session,
    server,
    activeSessionId,
    setActiveSessionId,
    closeSession,
    hibernateSession,
    duplicateSession,
    openNotes,
    renameSession,
    index,
    moveTab,
    progress = 0,
    paneColorSessions,
    identity,
}) => {
    const contextMenu = useContextMenu();
    const { popOutSession } = useActiveSessions();
    const { getParticipants } = useLiveSessions();
    const { user } = useContext(UserContext);
    const { t } = useTranslation();
    const [renameDialogOpen, setRenameDialogOpen] = useState(false);

    const otherParticipants = getParticipants(session.joinSessionId || session.id)
        .filter(participant => participant.accountId !== user?.id);

    const isNotes = session.type === "notes";
    const isOneDrive = session.type === "onedrive";
    // Both live in this browser only, so everything that needs a session the server knows about
    // is off for both.
    const isLocal = isNotes || isOneDrive;
    const isJoined = !!session.isJoined;
    const canPopOut = !session.scriptId && session.type !== "sftp" && !isLocal && !isJoined;
    const canShare = canPopOut;
    const canHibernate = !isLocal && !isJoined;
    const canDuplicate = !isLocal && !isJoined;
    const canOpenNotes = !isLocal && !isJoined && !!server?.id && !session.scriptId;
    const isSharing = !!session.shareId;
    // Looked up by session id, not counted by position in the tab strip — the strip and the grid
    // can list sessions in different orders, and a lookup keeps them from disagreeing.
    const paneColor = paneColorFor(paneColorSessions.indexOf(session.id));
    // buildTabLabel never translates (see tabLabel.js) - each tooltip field's key is resolved
    // here, one field per line, into the native `title` attribute rather than the Tooltip
    // component: many tabs sit side by side, and a Tooltip instance per tab would bring its own
    // hover tracking for content that is plain text and needs none of that.
    const tabLabel = buildTabLabel(session, identity, t);
    const tabTooltip = tabLabel.tooltip.map(({ key, value }) => `${t(key)}: ${value}`).join("\n");

    const handleShare = useCallback(async (writable) => {
        const result = await postRequest(`connections/${session.id}/share`, { writable });
        if (result?.shareId) {
            const baseUrl = getBaseUrl() || window.location.origin;
            navigator.clipboard.writeText(`${baseUrl}/share/${result.shareId}`);
        }
    }, [session.id]);

    const handleStopSharing = useCallback(async () => {
        await deleteRequest(`connections/${session.id}/share`);
    }, [session.id]);

    const handleCopyLink = useCallback(() => {
        const baseUrl = getBaseUrl() || window.location.origin;
        navigator.clipboard.writeText(`${baseUrl}/share/${session.shareId}`);
    }, [session.shareId]);

    const handlePermissionChange = useCallback(async (writable) => {
        await patchRequest(`connections/${session.id}/share`, { writable });
    }, [session.id]);

    const handleRenameSubmit = useCallback((value) => {
        renameSession(session.id, value);
        setRenameDialogOpen(false);
    }, [renameSession, session.id]);

    const handleRenameClose = useCallback(() => setRenameDialogOpen(false), []);

    const [{ isDragging }, drag] = useDrag({
        type: "TAB",
        item: { index, sessionId: session.id },
        collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    });

    const [{ isOver }, drop] = useDrop({
        accept: "TAB",
        drop: (draggedItem) => {
            if (draggedItem.index !== index) moveTab(draggedItem.index, index);
        },
        collect: (monitor) => ({ isOver: monitor.isOver() }),
    });

    const radius = 10;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (progress / 100) * circumference;
    const showProgress = progress > 0 && progress < 100;
    
    const handleContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        contextMenu.open(e, { x: e.clientX, y: e.clientY });
    };

    const handleAuxClick = (e) => {
        if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            closeSession(session.id);
        }
    };

    return (
        <>
            <div ref={(node) => drag(drop(node))} onClick={() => setActiveSessionId(session.id)}
                onContextMenu={handleContextMenu}
                onAuxClick={handleAuxClick}
                className={`server-tab ${session.id === activeSessionId ? "server-tab-active" : ""} ${isDragging ? "dragging" : ""} ${isOver ? "drop-target" : ""}`}
                style={{ opacity: isDragging ? 0.5 : 1, ...(paneColor && { "--pane-color": paneColor }) }}>
                <div className={`progress-circle ${!showProgress ? "no-progress" : ""}`}>
                    {showProgress && (
                        <svg width="24" height="24" viewBox="0 0 24 24">
                            <circle
                                cx="12"
                                cy="12"
                                r={radius}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                className="progress-bg"
                            />
                            <circle
                                cx="12"
                                cy="12"
                                r={radius}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeDasharray={circumference}
                                strokeDashoffset={offset}
                                strokeLinecap="round"
                                className="progress-bar"
                                transform="rotate(-90 12 12)"
                            />
                        </svg>
                    )}
                    <Icon path={isNotes ? mdiNoteEditOutline : isOneDrive ? mdiMicrosoft : getIconPath(server.icon)} className="progress-icon" />
                </div>
                <h2 title={tabTooltip}>{tabLabel.text}</h2>
                <AvatarStack className="tab-participants" users={otherParticipants} max={2}
                             getKey={participant => participant.viewerId} />
                <div className="tab-actions">
                    <Icon path={mdiClose} className="close-btn" title="Close Session" onClick={(e) => {
                        e.stopPropagation();
                        closeSession(session.id);
                    }} />
                </div>
            </div>
            <ContextMenu
                isOpen={contextMenu.isOpen}
                position={contextMenu.position}
                onClose={contextMenu.close}
                trigger={contextMenu.triggerRef}
            >
                {/* Unconditional, unlike every item below it: a name has to find its way back to
                    every tab kind on reload/rejoin, joined sessions included - copying canDuplicate's
                    !isLocal && !isJoined guard here would silently take that away from exactly the
                    sessions (join-<liveSessionId> ids are deterministic) that most need it. */}
                <ContextMenuItem
                    icon={mdiRenameBox}
                    label={t("servers.tabs.contextMenu.rename")}
                    onClick={() => setRenameDialogOpen(true)}
                />
                <ContextMenuSeparator />
                {canPopOut && (
                    <>
                        <ContextMenuItem
                            icon={mdiOpenInNew}
                            label={t("servers.tabs.contextMenu.popOut")}
                            onClick={() => popOutSession(session.id)}
                        />
                        <ContextMenuSeparator />
                    </>
                )}
                {canShare && !isSharing && (
                    <ContextMenuItem icon={mdiShareVariant} label={t("servers.tabs.contextMenu.startSharing")}>
                        <ContextMenuItem icon={mdiEye} label={t("servers.tabs.contextMenu.readOnly")} onClick={() => handleShare(false)} />
                        <ContextMenuItem icon={mdiPencil} label={t("servers.tabs.contextMenu.readWrite")} onClick={() => handleShare(true)} />
                    </ContextMenuItem>
                )}
                {canShare && isSharing && (
                    <>
                        <ContextMenuItem icon={mdiLinkVariant} label={t("servers.tabs.contextMenu.copyShareLink")} onClick={handleCopyLink} />
                        <ContextMenuItem icon={mdiShareVariant} label={t("servers.tabs.contextMenu.changePermissions")}>
                            <ContextMenuItem icon={mdiEye} label={t("servers.tabs.contextMenu.readOnly")} onClick={() => handlePermissionChange(false)} disabled={!session.shareWritable} />
                            <ContextMenuItem icon={mdiPencil} label={t("servers.tabs.contextMenu.readWrite")} onClick={() => handlePermissionChange(true)} disabled={session.shareWritable} />
                        </ContextMenuItem>
                        <ContextMenuItem icon={mdiCloseCircle} label={t("servers.tabs.contextMenu.stopSharing")} onClick={handleStopSharing} danger />
                        <ContextMenuSeparator />
                    </>
                )}
                {canOpenNotes && (
                    <ContextMenuItem
                        icon={mdiNoteEditOutline}
                        label={t("servers.tabs.contextMenu.openNotes")}
                        onClick={() => openNotes?.(server.id)}
                    />
                )}
                {canDuplicate && (
                    <ContextMenuItem
                        icon={mdiContentDuplicate}
                        label={t("servers.tabs.contextMenu.duplicate")}
                        onClick={() => duplicateSession(session.id)}
                    />
                )}
                {canHibernate && (
                    <ContextMenuItem
                        icon={mdiSleep}
                        label={t("servers.tabs.contextMenu.hibernateSession")}
                        onClick={() => hibernateSession(session.id)}
                    />
                )}
                <ContextMenuItem
                    icon={mdiClose}
                    label={t("servers.tabs.contextMenu.closeSession")}
                    onClick={() => closeSession(session.id)}
                    danger
                />
            </ContextMenu>
            <RenameTabDialog
                open={renameDialogOpen}
                initialValue={tabLabel.text}
                onSubmit={handleRenameSubmit}
                onClose={handleRenameClose}
            />
        </>
    );
};

export const ServerTabs = ({
    activeSessions,
    setActiveSessionId,
    activeSessionId,
    closeSession,
    hibernateSession,
    duplicateSession,
    openNotes,
    renameSession,
    layoutMode,
    onToggleSplit,
    paneColorSessions = [],
    orderRef,
    onTabOrderChange,
    onBroadcastToggle,
    onSnippetSelected,
    broadcastEnabled,
    onKeyboardShortcut,
    hasGuacamole,
    sessionProgress = {},
    fullscreenEnabled,
    onFullscreenToggle,
    tabIdentities = {},
}) => {

    const tabsRef = useRef(null);

    const [tabOrder, setTabOrder] = useState([]);
    const [showLeftArrow, setShowLeftArrow] = useState(false);
    const [showRightArrow, setShowRightArrow] = useState(false);

    const activeSession = activeSessions.find(session => session.id === activeSessionId);

    useEffect(() => {
        const currentSessionIds = activeSessions.map(session => session.id);
        const orderSessionIds = tabOrder.map(id => id);
        const sessionsChanged = currentSessionIds.length !== orderSessionIds.length ||
            currentSessionIds.some(id => !orderSessionIds.includes(id)) ||
            orderSessionIds.some(id => !currentSessionIds.includes(id));

        if (sessionsChanged) {
            const newOrder = [];

            tabOrder.forEach(sessionId => {
                if (currentSessionIds.includes(sessionId)) newOrder.push(sessionId);
            });

            currentSessionIds.forEach(sessionId => {
                if (!newOrder.includes(sessionId)) newOrder.push(sessionId);
            });

            setTabOrder(newOrder);

            if (orderRef) orderRef.current = newOrder;
            if (onTabOrderChange) onTabOrderChange(newOrder);
        }
    }, [activeSessions, tabOrder, orderRef]);

    useEffect(() => {
        if (orderRef && tabOrder.length > 0) orderRef.current = tabOrder;
    }, [tabOrder, orderRef]);

    const checkScrollPosition = () => {
        if (!tabsRef.current) return;

        const { scrollLeft, scrollWidth, clientWidth } = tabsRef.current;
        setShowLeftArrow(scrollLeft > 0);
        setShowRightArrow(scrollLeft < scrollWidth - clientWidth - 1);
    };

    useEffect(() => {
        checkScrollPosition();

        const tabs = tabsRef.current;
        if (!tabs) return;

        const observer = new ResizeObserver(() => checkScrollPosition());
        observer.observe(tabs);
        for (const child of tabs.children) observer.observe(child);

        return () => observer.disconnect();
    }, [activeSessions, tabOrder]);

    useEffect(() => {
        const tabs = tabsRef.current;
        if (!tabs) return;

        const handleWheel = (e) => {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
            if (tabs.scrollWidth <= tabs.clientWidth) return;

            e.preventDefault();
            tabs.scrollLeft += e.deltaY;
        };

        tabs.addEventListener('wheel', handleWheel, { passive: false });
        return () => tabs.removeEventListener('wheel', handleWheel);
    }, []);

    useEffect(() => {
        const activeTab = tabsRef.current?.querySelector('.server-tab-active');
        activeTab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }, [activeSessionId, tabOrder]);

    const scrollTabs = (direction) => {
        if (!tabsRef.current) return;

        const scrollAmount = Math.max(120, tabsRef.current.clientWidth * 0.8);
        const targetScroll = tabsRef.current.scrollLeft + (direction === 'left' ? -scrollAmount : scrollAmount);

        tabsRef.current.scrollTo({
            left: targetScroll,
            behavior: 'smooth'
        });
    };

    const moveTab = (fromIndex, toIndex) => {
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || fromIndex >= tabOrder.length || toIndex < 0 || toIndex >= tabOrder.length) return;

        const newOrder = [...tabOrder];
        const [removed] = newOrder.splice(fromIndex, 1);
        newOrder.splice(toIndex, 0, removed);

        setTabOrder(newOrder);

        if (orderRef) orderRef.current = newOrder;
        if (onTabOrderChange) onTabOrderChange(newOrder);
    };

    const orderedSessions = tabOrder.map(sessionId => activeSessions.find(session => session.id === sessionId)).filter(Boolean);

    return (
        <div className="server-tabs">
            <div className="layout-controls">
                <TerminalActionsMenu
                    layoutMode={layoutMode}
                    onBroadcastToggle={onBroadcastToggle}
                    onSnippetSelected={onSnippetSelected}
                    broadcastEnabled={broadcastEnabled}
                    onKeyboardShortcut={onKeyboardShortcut}
                    hasGuacamole={hasGuacamole}
                    fullscreenEnabled={fullscreenEnabled}
                    onFullscreenToggle={onFullscreenToggle}
                    activeSession={activeSession}
                />
                <Icon path={mdiViewSplitVertical} className={`layout-btn ${layoutMode !== "single" ? "active" : ""}`}
                    title={layoutMode === "single" ? "Enable Split View" : "Disable Split View"}
                    onClick={onToggleSplit} />
            </div>
            <div className="tabs-container">
                {showLeftArrow && (
                    <div className="scroll-indicator left">
                        <button type="button" aria-label="Scroll tabs left" onClick={() => scrollTabs('left')}>
                            <Icon path={mdiChevronLeft} />
                        </button>
                    </div>
                )}
                <div className="tabs" ref={tabsRef} onScroll={checkScrollPosition}>
                    {orderedSessions.map((session, index) => {
                        return (
                            <DraggableTab key={session.id} session={session} server={session.server} index={index} moveTab={moveTab}
                                activeSessionId={activeSessionId} setActiveSessionId={setActiveSessionId}
                                closeSession={closeSession} hibernateSession={hibernateSession} duplicateSession={duplicateSession}
                                openNotes={openNotes} renameSession={renameSession}
                                progress={sessionProgress[session.id] || 0}
                                paneColorSessions={paneColorSessions}
                                identity={tabIdentities[session.id]} />
                        );
                    })}
                </div>
                {showRightArrow && (
                    <div className="scroll-indicator right">
                        <button type="button" aria-label="Scroll tabs right" onClick={() => scrollTabs('right')}>
                            <Icon path={mdiChevronRight} />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
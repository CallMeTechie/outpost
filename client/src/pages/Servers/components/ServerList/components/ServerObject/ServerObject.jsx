import "./styles.sass";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useLiveSessions } from "@/common/contexts/LiveSessionContext.jsx";
import { useActiveSessions } from "@/common/contexts/SessionContext.jsx";
import { useTranslation } from "react-i18next";
import { useContext, useRef, useState } from "react";
import { useDrag, useDrop } from "react-dnd";
import { patchRequest } from "@/common/utils/RequestUtil.js";
import { DropIndicator } from "../DropIndicator";

export const ServerObject = ({ id, name, position, folderId, organizationId, nestedLevel, type, connectToServer, status, tags = [], hibernatedSessionCount = 0 }) => {
    const { loadServers, getServerById } = useContext(ServerContext);
    const { getLiveSessionsForEntry } = useLiveSessions();
    const { activeSessions, activeSessionId } = useActiveSessions();
    const { t } = useTranslation();
    const [dropPlacement, setDropPlacement] = useState(null);
    const elementRef = useRef(null);

    const isIntegrationEntry = Boolean(type?.startsWith("pve-"));

    // UI-SERVERS-LIST, state selected: the entry the foreground session belongs
    // to. The class was constant before, so the list never showed which server
    // the visible terminal is on.
    const isSelected = activeSessions?.some((session) =>
        session.id === activeSessionId && session.server?.id === id);

    const [{ opacity }, dragRef] = useDrag({
        item: { type: "server", id, folderId, position, isIntegrationEntry },
        type: "server",
        collect: monitor => ({
            opacity: monitor.isDragging() ? 0.5 : 1,
        }),
    });

    const [{ isOver }, dropRef] = useDrop({
        accept: "server",
        canDrop: (item) => item.isIntegrationEntry ? item.folderId === folderId : !isIntegrationEntry,
        hover: (item, monitor) => {
            if (!elementRef.current || item.id === id || !monitor.canDrop()) return;
            
            const hoverBoundingRect = elementRef.current.getBoundingClientRect();
            const hoverMiddleY = (hoverBoundingRect.bottom - hoverBoundingRect.top) / 2;
            const clientOffset = monitor.getClientOffset();
            const hoverClientY = clientOffset.y - hoverBoundingRect.top;

            const placement = hoverClientY < hoverMiddleY ? 'before' : 'after';
            setDropPlacement(placement);
        },
        drop: async (item) => {
            if (item.id === id) return;
            
            try {
                await patchRequest(`entries/${item.id}/reposition`, {
                    targetId: id,
                    placement: dropPlacement || 'after',
                    folderId: folderId,
                    organizationId: organizationId,
                });
                
                loadServers();
            } catch (error) {
                console.error("Failed to reposition entry", error);
            }
            
            setDropPlacement(null);
            return { id };
        },
        collect: (monitor) => ({
            isOver: monitor.isOver() && monitor.canDrop(),
        }),
    });

    const server = getServerById(id);

    const liveSessions = getLiveSessionsForEntry(id);

    const connect = () => {
        connectToServer(server.id, server.identities?.[0]);
    };

    const noteLine = server?.showNoteInList
        ? (server?.notes || "").split(/\r?\n/)[0].trim()
        : "";

    // The dot is lit when something is actually running on the entry: a live
    // session, or - for Proxmox entries, which report one - a status other than
    // offline or stopped.
    const isOnline = liveSessions.length > 0
        || (Boolean(status) && status !== "offline" && status !== "stopped");
    const statusTitle = isOnline ? t("servers.list.online") : t("servers.list.offline");

    // One line of meta, in order of what a glance needs first. The title carries
    // everything, so nothing is lost by showing only the most urgent part.
    const metaParts = [];
    if (liveSessions.length > 0) metaParts.push(t("servers.list.sessions", { count: liveSessions.length }));
    if (hibernatedSessionCount > 0) metaParts.push(t("servers.list.sleeping", { count: hibernatedSessionCount }));
    if (noteLine) metaParts.push(noteLine);
    const metaText = metaParts[0] || "";
    const metaTitle = metaParts.length > 1 ? metaParts.join(" · ") : undefined;

    return (
        <div
            className={`server-object${isSelected ? " selected" : ""}`}
            aria-selected={isSelected}
            style={{ paddingLeft: `${16 + (nestedLevel * 14)}px`, opacity, position: "relative" }}
            data-id={id}
            ref={(node) => {
                elementRef.current = node;
                dragRef(dropRef(node));
            }}
            onDoubleClick={connect}
            onMouseLeave={() => setDropPlacement(null)}>
            <DropIndicator show={isOver && dropPlacement === "before"} placement="before" />

            {/* The artboard's row: status dot, name, meta. What used to hang off
                the row as its own element - the icon, a note line, the sleep
                badge, shared-session avatars - is condensed into the meta
                column, and tag colours into a stripe at the row's edge. */}
            <span className={`server-dot${isOnline ? " on" : ""}`} title={statusTitle} />

            <span className="server-name truncate-text">{name}</span>

            {metaText && <span className="server-meta" title={metaTitle}>{metaText}</span>}

            {tags && tags.length > 0 && (
                <span className="server-tag-stripe" title={tags.map((tag) => tag.name).join(", ")}>
                    {tags.slice(0, 3).map((tag) => (
                        <i key={tag.id} style={{ backgroundColor: tag.color }} />
                    ))}
                </span>
            )}

            <DropIndicator show={isOver && dropPlacement === "after"} placement="after" />
        </div>
    );
};
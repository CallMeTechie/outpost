import { useState, useCallback, useRef } from "react";
import { resolveDropTarget, DRAG_PROVIDER } from "../../../utils/dropTransfer.js";

export const useDragDrop = ({ path, sessionId, selectedItems, isItemSelected, moveFiles, copyFiles, startTransfer, dragDropAction, updatePath }) => {
    const [draggedItems, setDraggedItems] = useState([]);
    const [dropTarget, setDropTarget] = useState(null);
    const [pendingDrop, setPendingDrop] = useState(null);
    const dragImageRef = useRef(null);
    const hoverTimerRef = useRef(null);

    const handleDragStart = useCallback((event, item) => {
        const itemsToDrag = isItemSelected(item) ? selectedItems : [item];
        setDraggedItems(itemsToDrag);
        const paths = itemsToDrag.map(i => `${path}/${i.name}`);
        const dragData = { paths, items: itemsToDrag, sessionId, provider: DRAG_PROVIDER };
        event.dataTransfer.setData("text/plain", JSON.stringify(dragData));
        event.dataTransfer.setData("application/x-sftp-files", JSON.stringify(dragData));
        event.dataTransfer.effectAllowed = "copyMove";
        
        if (dragImageRef.current) {
            const preview = dragImageRef.current;
            const iconsContainer = preview.querySelector('.drag-icons');
            const badge = preview.querySelector('.drag-badge');
            if (iconsContainer && badge) {
                iconsContainer.querySelectorAll('.drag-icon-wrapper').forEach(el => el.remove());
                itemsToDrag.slice(0, 3).reverse().forEach((dragItem, idx) => {
                    const reverseIdx = Math.min(itemsToDrag.length, 3) - 1 - idx;
                    const iconWrapper = document.createElement('div');
                    iconWrapper.className = 'drag-icon-wrapper';
                    iconWrapper.style.cssText = `transform:translate(${reverseIdx * 6}px,${reverseIdx * 6}px);z-index:${idx + 1}`;
                    iconWrapper.innerHTML = `<svg viewBox="0 0 24 24"><path fill="currentColor" d="${dragItem.type === 'folder' ? 'M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z' : 'M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z'}"/></svg>`;
                    iconsContainer.insertBefore(iconWrapper, badge);
                });
                badge.textContent = itemsToDrag.length > 1 ? itemsToDrag.length : '';
                badge.style.display = itemsToDrag.length > 1 ? 'flex' : 'none';
                event.dataTransfer.setDragImage(preview, -5, -5);
            }
        }
    }, [selectedItems, isItemSelected, path, sessionId]);

    const handleDragEnd = useCallback(() => {
        setDraggedItems([]);
        setDropTarget(null);
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    }, []);

    const handleDragOver = useCallback((event, item) => {
        if (item.type !== "folder" || !event.dataTransfer.types.includes("application/x-sftp-files")) return;
        event.preventDefault();
        event.stopPropagation();
        if (dropTarget !== item.name) {
            setDropTarget(item.name);
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = setTimeout(() => {
                updatePath(`${path.endsWith("/") ? path : path + "/"}${item.name}`);
                setDropTarget(null);
            }, 800);
        }
    }, [dropTarget, path, updatePath]);

    const handleDragLeave = useCallback((event) => {
        const relatedTarget = event.relatedTarget;
        if (relatedTarget && event.currentTarget.contains(relatedTarget)) return;
        setDropTarget(null);
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    }, []);

    // "ask" when the preference leaves the choice to the user, otherwise whether the drop was
    // really handed over. All three handlers say so: startTransfer returns null when it refused or
    // could not send, moveFiles and copyFiles pass on whether their message left the socket. A drop
    // that never went out must neither clear the selection the user still needs for the second
    // attempt nor be mistaken for an open question.
    const executeDrop = useCallback((decision, action) => {
        if (action !== "move" && action !== "copy") return "ask";
        const handled = decision.kind === "transfer"
            ? startTransfer?.({
                paths: decision.paths, destination: decision.destination,
                sourceSessionId: decision.sourceSessionId, action,
            })
            : action === "move"
                ? moveFiles?.(decision.paths, decision.destination)
                : copyFiles?.(decision.paths, decision.destination);
        return handled ? "done" : "failed";
    }, [moveFiles, copyFiles, startTransfer]);

    const handleDrop = useCallback((event, item, onClearSelection, openDropMenu) => {
        event.preventDefault();
        event.stopPropagation();
        if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
        setDropTarget(null);
        setDraggedItems([]);
        if (item.type !== "folder") return;
        try {
            const data = JSON.parse(event.dataTransfer.getData("application/x-sftp-files"));
            const destination = `${path.endsWith("/") ? path : path + "/"}${item.name}`;
            const decision = resolveDropTarget({ data, sessionId, destination, excludeName: item.name });
            if (decision.kind === "reject") return;
            const outcome = executeDrop(decision, dragDropAction);
            if (outcome === "ask") {
                setPendingDrop(decision);
                openDropMenu(event);
            } else if (outcome === "done") {
                onClearSelection();
            }
        } catch {}
    }, [path, sessionId, dragDropAction, executeDrop]);

    const handleContainerDrop = useCallback((event, onClearSelection, openDropMenu) => {
        event.preventDefault();
        event.stopPropagation();
        setDraggedItems([]);
        try {
            const data = JSON.parse(event.dataTransfer.getData("application/x-sftp-files"));
            const decision = resolveDropTarget({ data, sessionId, destination: path, currentPath: path });
            if (decision.kind === "reject") return;
            const outcome = executeDrop(decision, dragDropAction);
            if (outcome === "ask") {
                setPendingDrop(decision);
                openDropMenu(event);
            } else if (outcome === "done") {
                onClearSelection();
            }
        } catch {}
    }, [path, sessionId, dragDropAction, executeDrop]);

    const handleDropAction = useCallback((action, onClearSelection, closeDropMenu) => {
        if (pendingDrop) {
            if (executeDrop(pendingDrop, action) === "done") onClearSelection();
            setPendingDrop(null);
        }
        closeDropMenu();
    }, [pendingDrop, executeDrop]);

    return {
        draggedItems,
        dropTarget,
        dragImageRef,
        handleDragStart,
        handleDragEnd,
        handleDragOver,
        handleDragLeave,
        handleDrop,
        handleContainerDrop,
        handleDropAction,
        setPendingDrop,
    };
};

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import {
    ChevronDown as IconChevronDown, Folder as IconFolder, StarOff as IconStarOff,
    TextCursorInput as IconTextCursorInput,
} from "lucide-react";
import { ContextMenu, ContextMenuItem, useContextMenu } from "@/common/components/ContextMenu";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { patchRequest, putRequest, deleteRequest } from "@/common/utils/RequestUtil.js";
import { splitForOverflow } from "../../utils/favoritesOverflow.js";
import { normalizeBookmarkPath } from "../../utils/bookmarkPath.js";
import { publishBookmarksChanged } from "../../utils/bookmarkNotifier.js";
import FavoriteChip from "./components/FavoriteChip";
// The MIME type lives next to the setData call that writes it; the folder's index.js exports the
// component alone, the way every other component folder here does.
import { FAVORITE_CHIP_MIME } from "./components/FavoriteChip/FavoriteChip.jsx";
import "./styles.sass";

// The three lengths the split needs, in pixels, mirroring styles.sass: tokens.$space-4 of padding
// at each end, tokens.$space-2 between two chips, and the 1.5rem overflow button.
const PADDING_X = 16;
const GAP = 8;
const CHEVRON_WIDTH = 24;

export const FavoritesBar = ({ entryId, directory, bookmarks, onNavigate, onReload, onReorder }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const chipMenu = useContextMenu();
    const overflowMenu = useContextMenu();

    const barRef = useRef(null);
    const chipRefs = useRef(new Map());

    const [available, setAvailable] = useState(null);
    const [widths, setWidths] = useState([]);
    // The bookmark ID, never an index: the list can be reordered or reloaded from another tile
    // while any of these is set, and an index would then name a different bookmark.
    const [renamingId, setRenamingId] = useState(null);
    const [focusedId, setFocusedId] = useState(null);
    const [menuId, setMenuId] = useState(null);
    const [draggingId, setDraggingId] = useState(null);
    const [dropIndex, setDropIndex] = useState(null);

    // The bar, never the row of chips: observing a box whose children the split changes is a feedback
    // loop. The zero guard is the same one ViewContainer.jsx uses - a width of 0 is "not laid out yet",
    // not "nothing fits", and splitForOverflow would answer with the chevron alone for one frame.
    useEffect(() => {
        const bar = barRef.current;
        if (!bar) return;
        const measure = () => {
            const width = bar.clientWidth;
            if (width === 0) return;
            setAvailable(width - PADDING_X * 2);
            // Keyed by bookmark id and rebuilt in bookmark order. A Map iterated by insertion order
            // drifts out of step with `bookmarks` after the first reorder, and the ref of a deleted chip
            // stays in it forever - both make the indices in `hidden` point at the wrong chips.
            setWidths(bookmarks.map((b) => chipRefs.current.get(b.id)?.getBoundingClientRect().width ?? 0));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(bar);
        return () => observer.disconnect();
    }, [bookmarks]);

    // Nothing measured yet is not "nothing fits": splitForOverflow answers {visible: 0} for an
    // unmeasured bar, which would blank the row for one frame and then pop every chip in.
    const measured = available !== null && widths.length === bookmarks.length;
    const { visible, hidden } = useMemo(
        () => (measured
            ? splitForOverflow({ widths, available, gap: GAP, chevronWidth: CHEVRON_WIDTH })
            : { visible: bookmarks.length, hidden: [] }),
        [measured, widths, available, bookmarks.length],
    );

    // A reload from another tile can take the bookmark being renamed away while the field is open.
    // Derived rather than reset from an effect: the id simply stops matching any chip, so the rename
    // ends without a word and without a second render.
    const renamingBookmarkId = bookmarks.some((b) => b.id === renamingId) ? renamingId : null;

    // The chevron's own selected state, and the guard against an overflow menu that outlived what it
    // listed: widening the tile until everything fits takes the chevron away, and an open menu with
    // nothing in it would stay behind.
    const overflowOpen = overflowMenu.isOpen && hidden.length > 0;

    // Compared as normalized paths, never as raw strings - the server stores the normalized form,
    // and "/volume1/docker/" would otherwise never match the stored "/volume1/docker".
    const shownDirectory = normalizeBookmarkPath(directory);

    const commitRename = async (id, name) => {
        const trimmed = name.trim();
        const bookmark = bookmarks.find((b) => b.id === id);
        setRenamingId(null);
        // An empty field and an unchanged name are both "nothing to do" - the server would answer
        // the first with a 400 and the second with a write nobody asked for.
        if (!trimmed || !bookmark || trimmed === bookmark.name) return;
        try {
            await patchRequest(`bookmarks/${id}`, { name: trimmed });
        } catch (error) {
            // A 404 means another tile removed it while this one was typing. The end state is not
            // what was asked for, but it is not a failure either: reload, no toast.
            if (error?.code !== 404) {
                sendToast(t("common.error"), error?.message ?? t("common.error"));
                return;
            }
            await onReload().catch(() => {});
            return;
        }
        publishBookmarksChanged({ entryId });
        await onReload().catch(() => {});
    };

    const removeBookmark = async (id) => {
        if (renamingBookmarkId === id) setRenamingId(null);
        try {
            await deleteRequest(`bookmarks/${id}`);
        } catch (error) {
            // A 404 is the desired end state reached by somebody else, not an error.
            if (error?.code !== 404) {
                sendToast(t("common.error"), error?.message ?? t("common.error"));
                return;
            }
        }
        publishBookmarksChanged({ entryId });
        await onReload().catch(() => {});
    };

    const commitOrder = async (ids) => {
        // Optimistic: the row reorders immediately, the request only confirms it.
        const next = ids.map((id) => bookmarks.find((b) => b.id === id));
        // A reload from another tile may have landed between the drag and the drop. An id we can no
        // longer resolve means this list is stale - reload instead of drawing an undefined chip.
        if (next.some((b) => !b)) return onReload().catch(() => {});
        onReorder(next);
        try {
            await putRequest(`entries/${entryId}/bookmarks/order`, { ids });
            publishBookmarksChanged({ entryId });
        } catch (error) {
            // 409 is the ordinary outcome: this tile sorted on a stale list. Anything else is a real
            // failure and must not masquerade as one. The reload is guarded because it goes over the
            // same wire that just failed; an unguarded rejection from a keydown handler has no caller
            // left to catch it.
            await onReload().catch(() => {});
            if (error?.code !== 409) sendToast(t("common.error"), error?.message ?? t("common.error"));
        }
    };

    // Exactly one chip carries tabIndex 0, so the whole bar is a single tab stop and the arrow keys
    // do the rest of the walking. Falls back to the first chip whenever the remembered one is gone
    // or has moved into the overflow.
    const focusedIndex = bookmarks.findIndex((b) => b.id === focusedId);
    const tabbableIndex = focusedIndex >= 0 && focusedIndex < visible ? focusedIndex : 0;

    const focusChip = (index) => {
        if (index < 0 || index >= visible) return;
        const bookmark = bookmarks[index];
        setFocusedId(bookmark.id);
        chipRefs.current.get(bookmark.id)?.focus();
    };

    // Shift+Arrow moves the focused chip one position. Bounded by the visible run: a chip pushed past
    // the last visible position would land under the chevron, where visibility:hidden takes the focus
    // with it and the keyboard user is left standing nowhere.
    const moveChip = (index, direction) => {
        const target = index + direction;
        if (target < 0 || target >= visible) return;
        const ids = bookmarks.map((b) => b.id);
        const [moved] = ids.splice(index, 1);
        ids.splice(target, 0, moved);
        commitOrder(ids);
    };

    const handleChipKeyDown = (e, index) => {
        // While this chip is being renamed the input owns every key; its own handler stops them here.
        if (renamingBookmarkId === bookmarks[index].id) return;
        if (e.key === "Enter") {
            e.preventDefault();
            onNavigate(bookmarks[index].path);
            return;
        }
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const direction = e.key === "ArrowLeft" ? -1 : 1;
        if (e.shiftKey) moveChip(index, direction);
        else focusChip(index + direction);
    };

    // The pane's own drag handler steps aside for this type, so the bar has to preventDefault itself
    // or the browser refuses the drop. stopPropagation keeps the pane from seeing it at all.
    const handleDragOver = (e) => {
        if (!e.dataTransfer.types.includes(FAVORITE_CHIP_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const chip = e.target.closest?.("[data-bookmark-id]");
        if (!chip) return setDropIndex(visible);
        const index = bookmarks.findIndex((b) => String(b.id) === chip.dataset.bookmarkId);
        if (index === -1 || index >= visible) return;
        const rect = chip.getBoundingClientRect();
        setDropIndex(e.clientX > rect.left + rect.width / 2 ? index + 1 : index);
    };

    const handleDragLeave = (e) => {
        if (barRef.current?.contains(e.relatedTarget)) return;
        setDropIndex(null);
    };

    const handleDrop = (e) => {
        if (!e.dataTransfer.types.includes(FAVORITE_CHIP_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        const id = Number(e.dataTransfer.getData(FAVORITE_CHIP_MIME));
        const target = dropIndex;
        setDraggingId(null);
        setDropIndex(null);
        const from = bookmarks.findIndex((b) => b.id === id);
        if (from === -1 || target === null) return;
        // The insertion point counts positions in the row as drawn; taking the dragged chip out of
        // the list first shifts every position behind it by one.
        const to = target > from ? target - 1 : target;
        if (to === from) return;
        const ids = bookmarks.map((b) => b.id);
        ids.splice(from, 1);
        ids.splice(to, 0, id);
        commitOrder(ids);
    };

    return (
        <>
            <div className="favorites-bar" data-ui-id="UI-FILES-FAVORITES" ref={barRef}
                 onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                {bookmarks.length === 0 && (
                    <span className="favorites-empty">{t("servers.fileManager.favorites.empty")}</span>
                )}
                {bookmarks.map((bookmark, index) => (
                    <Fragment key={bookmark.id}>
                        {dropIndex === index && index < visible && <span className="insert" aria-hidden="true" />}
                        <FavoriteChip
                            bookmark={bookmark}
                            selected={normalizeBookmarkPath(bookmark.path) === shownDirectory}
                            hidden={index >= visible}
                            dragging={draggingId === bookmark.id}
                            renaming={renamingBookmarkId === bookmark.id}
                            tabIndex={index === tabbableIndex && index < visible ? 0 : -1}
                            chipRef={(el) => {
                                if (el) chipRefs.current.set(bookmark.id, el);
                                else chipRefs.current.delete(bookmark.id);
                            }}
                            onClick={() => onNavigate(bookmark.path)}
                            onContextMenu={(e) => {
                                setMenuId(bookmark.id);
                                chipMenu.open(e, { x: e.pageX, y: e.pageY });
                            }}
                            onKeyDown={(e) => handleChipKeyDown(e, index)}
                            onFocus={() => setFocusedId(bookmark.id)}
                            onDragStart={setDraggingId}
                            onDragEnd={() => { setDraggingId(null); setDropIndex(null); }}
                            onRenameCommit={(name) => commitRename(bookmark.id, name)}
                            onRenameCancel={() => setRenamingId(null)} />
                    </Fragment>
                ))}
                {dropIndex !== null && dropIndex >= visible && <span className="insert" aria-hidden="true" />}
                {hidden.length > 0 && (
                    <button type="button" className={`favorites-overflow${overflowOpen ? " open" : ""}`}
                            data-ui-id="UI-FILES-FAVORITES-OVERFLOW" aria-haspopup="menu"
                            aria-expanded={overflowOpen} title={t("servers.fileManager.favorites.overflow")}
                            onClick={(e) => overflowMenu.open(e)}>
                        <Icon icon={IconChevronDown} />
                    </button>
                )}
            </div>

            {/* Removing asks nothing and is not danger-coloured: a bookmark is one right-click away
                from existing again, and the folder itself is never touched. */}
            <ContextMenu dataUiId="UI-FILES-FAVORITE-MENU" isOpen={chipMenu.isOpen} position={chipMenu.position}
                         onClose={chipMenu.close} trigger={chipMenu.triggerRef}>
                <ContextMenuItem icon={IconTextCursorInput} label={t("servers.fileManager.favorites.rename")}
                                 onClick={() => setRenamingId(menuId)} />
                <ContextMenuItem icon={IconStarOff} label={t("servers.fileManager.favorites.remove")}
                                 onClick={() => removeBookmark(menuId)} />
            </ContextMenu>

            {/* The hidden bookmarks, in the same order as the row they fell out of. */}
            <ContextMenu isOpen={overflowOpen} position={overflowMenu.position}
                         onClose={overflowMenu.close} trigger={overflowMenu.triggerRef}>
                {hidden.map((index) => bookmarks[index]).filter(Boolean).map((bookmark) => (
                    <ContextMenuItem key={bookmark.id} icon={IconFolder} label={bookmark.name}
                                     title={bookmark.path} onClick={() => onNavigate(bookmark.path)} />
                ))}
            </ContextMenu>
        </>
    );
};

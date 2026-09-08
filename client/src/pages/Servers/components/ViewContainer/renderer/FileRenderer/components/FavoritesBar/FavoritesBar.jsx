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
// The MIME type lives next to the setData call that writes it and travels out through the folder's
// index.js, so this file reaches into the folder exactly once.
import FavoriteChip, { FAVORITE_CHIP_MIME } from "./components/FavoriteChip";
import "./styles.sass";

// The overflow button's width, in rem, exactly as styles.sass writes it. The other two lengths the
// split needs - the bar's own horizontal padding and the gap between two chips - are read straight
// off the bar's computed style; only the chevron cannot be, because it is not in the DOM until the
// split has already decided that it is needed.
const CHEVRON_REM = 1.5;

// Hardcoding 16/8/24 was wrong: styles.sass expresses all three as tokens.$space-4, tokens.$space-2
// and 1.5rem, and main.sass sets the root font size to calc(16px * var(--ui-scale)). The chip
// widths are measured, so only these three would have stayed at their --ui-scale: 1 values - at
// 1.5 the budget came out about 28px too generous and overflow: hidden cut the last chip in half,
// which the spec forbids outright. rem is defined against the root element, so that is where the
// scale is read from; the padding and the gap come from the bar itself.
const measureLengths = (bar) => {
    const style = getComputedStyle(bar);
    const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return {
        paddingX: (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0),
        gap: parseFloat(style.columnGap) || 0,
        chevronWidth: CHEVRON_REM * rootFontSize,
    };
};

// One keystroke is one PUT only if nothing coalesces them: the shared bookmark limiter allows 60
// writes a minute across all four writing routes, so a held Shift+Arrow would spend that budget in
// about two seconds and get a 429 for the rest. The row stays optimistic the whole time; only the
// write waits for the key to come to rest.
const ORDER_DEBOUNCE_MS = 300;

export const FavoritesBar = ({ entryId, directory, bookmarks, onNavigate, onReload, onReorder }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const chipMenu = useContextMenu();
    const overflowMenu = useContextMenu();

    const barRef = useRef(null);
    const chipRefs = useRef(new Map());
    // The debounced order write: the pending timer and the call it will make. Refs rather than
    // state - both have to survive the re-render the optimistic reorder triggers, and neither is
    // ever read while rendering.
    const orderTimerRef = useRef(null);
    const flushOrderRef = useRef(null);

    // The available width and the three lengths it was measured against, kept together: they are
    // read in one pass off the same computed style and are only ever used together.
    const [metrics, setMetrics] = useState(null);
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
            const { paddingX, gap, chevronWidth } = measureLengths(bar);
            // clientWidth counts the padding, the chips do not sit in it. The previous object is
            // kept when nothing moved: a fresh one every observer callback would be a new identity
            // for the split's useMemo each time, for numbers that did not change.
            const next = { available: width - paddingX, gap, chevronWidth };
            setMetrics((prev) => (prev && prev.available === next.available && prev.gap === next.gap
                && prev.chevronWidth === next.chevronWidth ? prev : next));
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
    const measured = metrics !== null && widths.length === bookmarks.length;
    const { visible, hidden } = useMemo(
        () => (measured
            ? splitForOverflow({
                widths, available: metrics.available, gap: metrics.gap, chevronWidth: metrics.chevronWidth,
            })
            : { visible: bookmarks.length, hidden: [] }),
        [measured, widths, metrics, bookmarks.length],
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

    // Every failing write reports the same way: the server's own message when it sent one, the
    // generic string otherwise.
    const reportError = (error) => sendToast(t("common.error"), error?.message ?? t("common.error"));

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
                reportError(error);
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
                reportError(error);
                return;
            }
        }
        publishBookmarksChanged({ entryId });
        await onReload().catch(() => {});
    };

    const writeOrder = async (ids) => {
        try {
            await putRequest(`entries/${entryId}/bookmarks/order`, { ids });
            publishBookmarksChanged({ entryId });
        } catch (error) {
            // 409 is the ordinary outcome: this tile sorted on a stale list. 429 is the other one:
            // the shared bookmark limiter cut a burst of keyboard moves short. Neither is the user's
            // mistake and neither deserves a toast - the reload puts the row back in step either
            // way. Anything else is a real failure and must not masquerade as one. The reload is
            // guarded because it goes over the same wire that just failed; an unguarded rejection
            // from a keydown handler has no caller left to catch it.
            await onReload().catch(() => {});
            if (error?.code !== 409 && error?.code !== 429) reportError(error);
        }
    };

    // `debounce` is the keyboard path's flag alone. A drag ends in one drop and writes at once; a
    // held Shift+Arrow fires as fast as the key repeats, and every one of those keystrokes would
    // otherwise be its own PUT.
    const commitOrder = (ids, { debounce = false } = {}) => {
        // Optimistic: the row reorders immediately, the request only confirms it.
        const next = ids.map((id) => bookmarks.find((b) => b.id === id));
        // A reload from another tile may have landed between the drag and the drop. An id we can no
        // longer resolve means this list is stale - reload instead of drawing an undefined chip.
        if (next.some((b) => !b)) return onReload().catch(() => {});
        onReorder(next);

        // A write already scheduled is always superseded, never added to: `ids` is the complete
        // order, so the newest one alone says everything the older ones did.
        if (orderTimerRef.current) clearTimeout(orderTimerRef.current);
        orderTimerRef.current = null;
        flushOrderRef.current = null;
        if (!debounce) return writeOrder(ids);

        flushOrderRef.current = () => writeOrder(ids);
        orderTimerRef.current = setTimeout(() => {
            orderTimerRef.current = null;
            const flush = flushOrderRef.current;
            flushOrderRef.current = null;
            flush?.();
        }, ORDER_DEBOUNCE_MS);
    };

    // Closing the strip or losing the tile must not swallow the write the row is already showing:
    // the reorder was applied optimistically, so dropping the PUT would leave the server holding an
    // order nobody can see any more. Nothing in writeOrder touches this component's own state.
    useEffect(() => () => {
        if (!orderTimerRef.current) return;
        clearTimeout(orderTimerRef.current);
        orderTimerRef.current = null;
        flushOrderRef.current?.();
    }, []);

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
        commitOrder(ids, { debounce: true });
    };

    const handleChipKeyDown = (e, index) => {
        // While this chip is being renamed the input owns every key; its own handler stops them here.
        if (renamingBookmarkId === bookmarks[index].id) return;
        // role="button" promises both keys. Space also scrolls the pane if it is not stopped here.
        if (e.key === "Enter" || e.key === " ") {
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
        // A chip the split has hidden, or one no longer in the list, names no position in the row.
        // Falling through to the end of the visible run is the same answer the empty area gets -
        // leaving the previous marker standing would point at a place the drop will not use.
        if (index === -1 || index >= visible) return setDropIndex(visible);
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
                {/* The chevron toggles, it does not only open: ContextMenu's outside-click handler
                    exempts its own trigger, so a second click on an opened chevron would otherwise
                    do nothing at all. */}
                {hidden.length > 0 && (
                    <button type="button" className={`favorites-overflow${overflowOpen ? " open" : ""}`}
                            data-ui-id="UI-FILES-FAVORITES-OVERFLOW" aria-haspopup="menu"
                            aria-expanded={overflowOpen} title={t("servers.fileManager.favorites.overflow")}
                            onClick={(e) => overflowMenu.toggle(e)}>
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

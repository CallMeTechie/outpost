import { useRef, useState } from "react";
import Icon from "@/common/components/Icon";
import { Folder as IconFolder } from "lucide-react";

// The drag payload of a chip. It exists so FileRenderer.handleDrag can tell an internal reorder
// from a real upload: a chip is not a file, and a drag of one must not raise the pane's upload
// overlay.
export const FAVORITE_CHIP_MIME = "application/x-favorite-chip";

// Mounted only while this chip is being renamed, which is what keeps the typed value safe: the
// state is seeded once, at mount, so a bookmark list reloaded underneath us - another tile pinned
// something - re-renders the chip without touching what has been typed.
const RenameInput = ({ initialName, onCommit, onCancel }) => {
    const [value, setValue] = useState(initialName);
    // The field has three ways out - Enter, Escape and losing focus - and exactly one of them may
    // take effect. Today Escape happens to win because unmounting a focused node fires no blur
    // event, but that is a browser detail, not a decision. This latch makes the decision.
    const settledRef = useRef(false);
    const settle = (finish) => {
        if (settledRef.current) return;
        settledRef.current = true;
        finish();
    };

    // Enter confirms, Escape discards - the same two keys handleRenameKeyDown binds for a file in
    // FileList.jsx. stopPropagation keeps them away from the chip's own Enter/arrow handling, which
    // would otherwise navigate the pane while the name is still being typed.
    const handleKeyDown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            settle(() => onCommit(value));
        } else if (e.key === "Escape") {
            e.preventDefault();
            settle(onCancel);
        }
    };

    return (
        // maxLength mirrors renameBookmarkValidation on the server, so a name too long is stopped
        // where it is typed rather than coming back as a 400.
        <input type="text" className="rename-input" value={value} autoFocus maxLength={255}
               onChange={(e) => setValue(e.target.value)} onKeyDown={handleKeyDown}
               onBlur={() => settle(() => onCommit(value))} onClick={(e) => e.stopPropagation()} />
    );
};

// Deliberately not common/components/Chip: that one is a <button> with label/selected/onClick/icon/
// disabled and carries neither a title, nor a right-click, nor drag props - and an <input> inside a
// <button> cannot be operated at all.
export const FavoriteChip = ({
                                 bookmark,
                                 selected,
                                 hidden,
                                 dragging,
                                 renaming,
                                 tabIndex,
                                 chipRef,
                                 onClick,
                                 onContextMenu,
                                 onKeyDown,
                                 onFocus,
                                 onDragStart,
                                 onDragEnd,
                                 onRenameCommit,
                                 onRenameCancel,
                             }) => {
    const classNames = [
        "favorite-chip",
        selected && "selected",
        dragging && "dragging",
        renaming && "renaming",
        hidden && "is-hidden",
    ].filter(Boolean).join(" ");

    // The id travels, never the index: another tile can reorder the list between the dragstart and
    // the drop, and an index would then point at a different bookmark than the one being dragged.
    const handleDragStart = (e) => {
        e.dataTransfer.setData(FAVORITE_CHIP_MIME, String(bookmark.id));
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.(bookmark.id);
    };

    return (
        <div ref={chipRef} className={classNames} data-bookmark-id={bookmark.id} title={bookmark.path}
             onClick={renaming ? undefined : onClick} onContextMenu={onContextMenu} onKeyDown={onKeyDown}
             onFocus={onFocus} draggable={!renaming} onDragStart={handleDragStart} onDragEnd={onDragEnd}
             role={renaming ? undefined : "button"} tabIndex={renaming ? -1 : tabIndex}
             aria-current={selected ? "true" : undefined} aria-hidden={hidden ? "true" : undefined}>
            <Icon icon={IconFolder} />
            {renaming
                ? <RenameInput initialName={bookmark.name} onCommit={onRenameCommit} onCancel={onRenameCancel} />
                : <span className="favorite-chip-name">{bookmark.name}</span>}
        </div>
    );
};

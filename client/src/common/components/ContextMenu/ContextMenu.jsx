import React, { useEffect, useRef, useState } from "react";
import { matchesShortcut } from "./shortcuts.js";
import { createPortal } from "react-dom";
import "./styles.sass";

export const ContextMenu = ({ 
    isOpen, 
    position, 
    onClose, 
    children,
    trigger = null,
    // Optional design-manifest id, so a caller can mark its own menu without
    // this shared component knowing about any particular screen.
    dataUiId = undefined
}) => {
    const menuRef = useRef(null);
    const [adjustedPosition, setAdjustedPosition] = useState(position);
    const [isPositioned, setIsPositioned] = useState(false);
    const [isVisible, setIsVisible] = useState(false);

    const processChildren = (childrenToProcess) => {
        return React.Children.map(childrenToProcess, (child) => {
            if (!React.isValidElement(child)) return child;

            const { type } = child;
            if (type === React.Fragment) {
                return React.cloneElement(child, {}, processChildren(child.props.children));
            }
            if (typeof type === 'string') return child;
            return React.cloneElement(child, { onClose });
        });
    };

    useEffect(() => {
        if (isOpen) {
            setIsVisible(true);
            setAdjustedPosition(position);
            requestAnimationFrame(() => requestAnimationFrame(() => setIsPositioned(true)));
        } else {
            setIsPositioned(false);
        }
    }, [isOpen, position]);

    const handleAnimationEnd = (e) => {
        if (e.target === menuRef.current && !isOpen) {
            setIsVisible(false);
            setIsPositioned(false);
        }
    };

    useEffect(() => {
        if (!isOpen || !isPositioned || !menuRef.current) return;

        const menuRect = menuRef.current.getBoundingClientRect();
        const { innerWidth, innerHeight } = window;
        let { x, y } = position;

        x = Math.max(10, Math.min(x, innerWidth - menuRect.width - 10));
        y = Math.max(10, Math.min(y, innerHeight - menuRect.height - 10));

        setAdjustedPosition({ x, y });
    }, [isOpen, isPositioned, position]);

    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target) && 
                !(trigger?.contains?.(e.target))) {
                onClose();
            }
        };

        const handleKeyDown = (e) => {
            if (e.key === "Escape") return onClose();

            const items = menuRef.current?.querySelectorAll('.context-menu-item:not(.disabled):not(.custom)');
            if (!items?.length) return;

            const navigate = (dir) => {
                e.preventDefault();
                const currentIndex = Array.from(items).indexOf(document.activeElement);
                const nextIndex = (currentIndex + dir + items.length) % items.length;
                items[nextIndex]?.focus();
            };

            if (e.key === "ArrowDown") return navigate(1);
            if (e.key === "ArrowUp") return navigate(-1);

            // Accelerators, only while this menu is open -- see shortcuts.js on why they are
            // not page-wide. Searched in the DOM rather than derived from the children,
            // because the items are built conditionally by every caller and an open submenu
            // must be reachable too. Disabled items are excluded by the selector, so a
            // shortcut on a greyed-out entry does nothing, exactly like clicking it.
            // Plain Enter/Space belong to the focused item (ContextMenuItem's own handler).
            // Matching them here as well would run the action twice.
            const bare = !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
            if (bare && (e.key === "Enter" || e.key === " ")) return;

            const match = Array.from(menuRef.current?.querySelectorAll('.context-menu-item[data-shortcut]:not(.disabled)') || [])
                .find((item) => matchesShortcut(item.dataset.shortcut, e));
            if (match) {
                e.preventDefault();
                e.stopPropagation();
                match.click();
            }
        };

        document.addEventListener("mousedown", handleClickOutside);
        document.addEventListener("keydown", handleKeyDown);

        setTimeout(() => menuRef.current?.querySelector('.context-menu-item:not(.disabled):not(.custom)')?.focus(), 50);

        return () => {
            document.removeEventListener("mousedown", handleClickOutside);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [isOpen, onClose, trigger]);

    if (!isVisible) return null;

    const menu = (
        <div
            ref={menuRef}
            className={`context-menu ${isOpen && isPositioned ? 'open' : 'closed'}`}
            style={{
                left: `${adjustedPosition.x}px`,
                top: `${adjustedPosition.y}px`,
            }}
            role="menu"
            data-ui-id={dataUiId}
            aria-orientation="vertical"
            tabIndex={-1}
            onTransitionEnd={handleAnimationEnd}
        >
            {processChildren(children)}
        </div>
    );

    return createPortal(menu, document.body);
};

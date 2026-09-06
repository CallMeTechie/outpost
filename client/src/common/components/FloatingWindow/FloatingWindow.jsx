import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import { Square as IconSquare, Copy as IconCopy, X as IconX } from "lucide-react";
import { useWindowControls } from "@/common/hooks/useWindowControls.js";
import ResizeHandle from "@/common/components/ResizeHandle";
import "./styles.sass";

export const FloatingWindowAction = ({ className = "", ...props }) => (
    <button type="button" className={`floating-window__action${className ? " " + className : ""}`} {...props} />
);

export const FloatingWindow = ({
    className = "", icon, title, titleExtra, actions, onClose, initialSize, children,
}) => {
    const { t } = useTranslation();
    const {
        windowRef, headerRef, isMaximized, focusWindow, handleMouseDown, handleResizeStart,
        toggleMaximize, getWindowStyle, getWindowClasses,
    } = useWindowControls(initialSize);

    return createPortal(
        <div ref={windowRef} role="dialog" aria-modal="false" aria-label={title}
             className={`${getWindowClasses("floating-window")}${className ? " " + className : ""}`}
             style={getWindowStyle()} onMouseDownCapture={focusWindow}
             onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
            <div ref={headerRef} className="floating-window__header" onMouseDown={handleMouseDown}>
                <div className="floating-window__title">
                    {icon && <Icon icon={icon} />}
                    <h2>{title}</h2>
                    {titleExtra}
                </div>
                <div className="floating-window__actions">
                    {actions}
                    <button type="button" className="floating-window__action" onClick={toggleMaximize}
                            title={isMaximized ? t("common.restore") : t("common.maximize")}>
                        <Icon icon={isMaximized ? IconCopy : IconSquare} />
                    </button>
                    <button type="button" className="floating-window__action floating-window__action--close"
                            onClick={onClose} title={t("common.close")}>
                        <Icon icon={IconX} />
                    </button>
                </div>
            </div>

            {children}

            {!isMaximized && <ResizeHandle onMouseDown={handleResizeStart} />}
        </div>,
        document.body,
    );
};

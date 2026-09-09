import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import { X as IconX } from "lucide-react";
import Button from "@/common/components/Button";
import "./styles.sass";

export const DialogContext = createContext(() => {});

export const DialogProvider = ({ disableClosing, open, children, onClose, isDirty }) => {
    const { t } = useTranslation();
    const areaRef = useRef();
    const ref = useRef();
    const confirmRef = useRef();

    const [isVisible, setIsVisible] = useState(false);
    const [isClosing, setIsClosing] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);

    const closeInner = useCallback(() => {
        setShowConfirm(false);
        setIsClosing(true);
    }, []);

    // Held in a ref so tryClose stays stable: the dialogs hand in an inline arrow,
    // and the two document listeners re-subscribe on every identity change.
    const isDirtyRef = useRef(isDirty);
    useEffect(() => { isDirtyRef.current = isDirty; }, [isDirty]);

    const tryClose = useCallback(() => {
        if (disableClosing) return;

        const latest = isDirtyRef.current;
        // Called, not read: a dialog hands in an arrow so the dirty flag is computed at
        // close time, never during a render that a compiler may cache.
        const dirty = typeof latest === 'function' ? latest() : latest;
        if (dirty) {
            setShowConfirm(true);
            return;
        }
        closeInner();
    }, [disableClosing, closeInner]);

    const handleConfirmClose = useCallback(() => {
        closeInner();
    }, [closeInner]);

    const handleCancelClose = useCallback(() => {
        setShowConfirm(false);
    }, []);

    useEffect(() => {
        const handleClick = (event) => {
            if (showConfirm) {
                if (!confirmRef.current?.contains(event.target)) {
                    setShowConfirm(false);
                }
                return;
            }
            
            const isInsideDialog = ref.current?.contains(event.target);
            const isInsidePortal = !!document.getElementById('select-box-portal')?.contains(event.target)
                || !!event.target.closest('.icon-chooser__dropdown');
            
            if (!isInsideDialog && !isInsidePortal) {
                tryClose();
            }
        };

        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [ref, tryClose, showConfirm]);

    useEffect(() => {
        if (!open || disableClosing) return;

        const handleKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                if (showConfirm) {
                    setShowConfirm(false);
                } else {
                    tryClose();
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, disableClosing, tryClose, showConfirm]);

    useEffect(() => {
        if (open) {
            setIsVisible(true);
            setIsClosing(false);
            setShowConfirm(false);
        } else if (!isClosing) {
            closeInner();
        }
        // Closing runs through closeInner, which sets isClosing itself - listing it here
        // would let the open branch cancel the very close it just started.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const handleAnimationEnd = () => {
        if (isClosing) {
            setIsVisible(false);
            setIsClosing(false);
            if (onClose) onClose();
        }
    };

    const dialogContent = isVisible ? (
        <div className={`dialog-area ${isClosing ? "dialog-area-hidden" : ""}`} ref={areaRef}>
            <div className={`dialog ${isClosing ? "dialog-hidden" : ""}`} ref={ref}
                onAnimationEnd={handleAnimationEnd}>
                {!disableClosing && (
                    <button className="dialog-close-btn" onClick={tryClose} aria-label="Close dialog">
                        <Icon icon={IconX} size={0.9} />
                    </button>
                )}
                {children}
            </div>
            {showConfirm && (
                <div className="dialog-confirm-overlay">
                    <div className="dialog-confirm" ref={confirmRef}>
                        <h3>{t('common.confirmDialog.unsavedChangesTitle')}</h3>
                        <p>{t('common.confirmDialog.unsavedChangesText')}</p>
                        <div className="dialog-confirm-actions">
                            <button className="dialog-confirm-btn secondary" onClick={handleCancelClose}>
                                {t('common.actions.cancel')}
                            </button>
                            <button className="dialog-confirm-btn primary" onClick={handleConfirmClose}>
                                {t('common.actions.discard')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    ) : null;

    return (
        <DialogContext.Provider value={tryClose}>
            {createPortal(dialogContent, document.body)}
        </DialogContext.Provider>
    );
};

// A child component, not a hook in the dialogs: useContext resolves at the
// caller's position, and the dialogs render this provider themselves.
export const DialogCancelButton = ({ text, icon, disabled }) => {
    const tryClose = useContext(DialogContext);
    return <Button text={text} icon={icon} disabled={disabled} onClick={tryClose}
                   type="secondary" buttonType="button" />;
};

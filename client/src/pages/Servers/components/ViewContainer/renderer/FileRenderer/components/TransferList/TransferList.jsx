import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import { X as IconX } from "lucide-react";
import { transferPercent } from "../../utils/transferProgress.js";
import { transferDetailText } from "../../utils/transferDetail.js";
import { AUTO_DISMISS_DELAY_MS, shouldAutoDismiss } from "../../utils/transferAutoDismiss.js";

const TransferRow = ({ transfer, onCancel, onDismiss }) => {
    const { t } = useTranslation();
    const active = transfer.status === "running" || transfer.status === "cancelling";
    const cancelling = transfer.status === "cancelling";

    // The reducer never un-finishes a row once it reaches "done", so this fires at most once per
    // id. Cleanup covers both ways a row can leave before the timer does: dismissed by hand, or
    // the pane unmounting - either way nothing fires into a row that is no longer there. The
    // dispatch itself happens in the timeout callback, not in the effect body, so this is wiring
    // around the decision in transferAutoDismiss.js, not a second copy of it.
    useEffect(() => {
        if (!shouldAutoDismiss(transfer)) return;
        const timer = setTimeout(() => onDismiss?.(transfer.id), AUTO_DISMISS_DELAY_MS);
        return () => clearTimeout(timer);
    }, [transfer, onDismiss]);

    return (
        <div className={`transfer-row transfer-${transfer.status}`}>
            <div className="transfer-title">
                {/* The destination is a filesystem path - i18next's default HTML-escaping would
                    turn every "/" into "&#x2F;" in the rendered text, which React does not need
                    since it escapes on its own. */}
                {t(`servers.fileManager.transfers.${transfer.action === "move" ? "moving" : "copying"}`,
                    { destination: transfer.destination, interpolation: { escapeValue: false } })}
            </div>
            <div className="transfer-detail">{transferDetailText(transfer, t)}</div>
            {transfer.status === "done" && transfer.filesSkipped > 0 && (
                <div className="transfer-detail">
                    {t("servers.fileManager.transfers.skipped", { count: transfer.filesSkipped, interpolation: { escapeValue: false } })}
                </div>
            )}
            {transfer.leftovers?.length > 0 && (
                <div className="transfer-detail">
                    {t("servers.fileManager.transfers.leftovers", { files: transfer.leftovers.join(", "), interpolation: { escapeValue: false } })}
                </div>
            )}
            {active && <div className="transfer-bar" style={{ width: `${transferPercent(transfer)}%` }} />}
            <button
                className="transfer-action"
                title={cancelling
                    ? t("servers.fileManager.transfers.cancelling")
                    : active
                        ? t("servers.fileManager.transfers.cancel")
                        : t("servers.fileManager.transfers.dismiss")}
                disabled={cancelling}
                onClick={() => (active ? onCancel?.(transfer.id) : onDismiss?.(transfer.id))}>
                <Icon icon={IconX} size={0.7} />
            </button>
        </div>
    );
};

export const TransferList = ({ transfers = [], onCancel, onDismiss }) => {
    if (transfers.length === 0) return null;

    return (
        <div className="transfer-list">
            {transfers.map((transfer) => (
                <TransferRow key={transfer.id} transfer={transfer} onCancel={onCancel} onDismiss={onDismiss} />
            ))}
        </div>
    );
};

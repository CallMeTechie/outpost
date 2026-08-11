import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiClose } from "@mdi/js";
import { transferPercent } from "../../utils/transferProgress.js";
import { transferDetailText } from "../../utils/transferDetail.js";

export const TransferList = ({ transfers = [], onCancel, onDismiss }) => {
    const { t } = useTranslation();
    if (transfers.length === 0) return null;

    return (
        <div className="transfer-list">
            {transfers.map((transfer) => {
                const active = transfer.status === "running" || transfer.status === "cancelling";
                const cancelling = transfer.status === "cancelling";
                return (
                    <div className={`transfer-row transfer-${transfer.status}`} key={transfer.id}>
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
                            <Icon path={mdiClose} size={0.7} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
};

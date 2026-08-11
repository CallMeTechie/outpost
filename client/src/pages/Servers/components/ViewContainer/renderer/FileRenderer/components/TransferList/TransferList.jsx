import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiClose } from "@mdi/js";
import { transferPercent } from "../../utils/transferProgress.js";

const renderDetail = (transfer, t) => {
    switch (transfer.status) {
        case "error":
            return transfer.connectionLost
                ? t("servers.fileManager.transfers.connectionLost")
                : t("servers.fileManager.transfers.failed", { message: transfer.message });
        case "cancelled":
            return t("servers.fileManager.transfers.cancelled");
        case "done":
            return t("servers.fileManager.transfers.done", { count: transfer.filesTransferred ?? 0 });
        case "cancelling":
            return t("servers.fileManager.transfers.cancelling");
        default:
            return transfer.file ?? t("servers.fileManager.transfers.progress",
                { filesDone: transfer.filesDone ?? 0, filesTotal: transfer.filesTotal ?? 0 });
    }
};

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
                            {t(`servers.fileManager.transfers.${transfer.action === "move" ? "moving" : "copying"}`,
                                { destination: transfer.destination })}
                        </div>
                        <div className="transfer-detail">{renderDetail(transfer, t)}</div>
                        {transfer.status === "done" && transfer.filesSkipped > 0 && (
                            <div className="transfer-detail">
                                {t("servers.fileManager.transfers.skipped", { count: transfer.filesSkipped })}
                            </div>
                        )}
                        {transfer.leftovers?.length > 0 && (
                            <div className="transfer-detail">
                                {t("servers.fileManager.transfers.leftovers", { files: transfer.leftovers.join(", ") })}
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

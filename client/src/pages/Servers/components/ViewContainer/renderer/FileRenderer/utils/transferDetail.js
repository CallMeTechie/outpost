import { transferPercent } from "./transferProgress.js";

// The default branch's line is the one users actually watch for the whole transfer, so it
// doubles as the answer to "is anything happening" once the fixed-text branches (done, error,
// cancelled, cancelling) don't apply. Appending the percent here — not just leaving the filename
// or the file count — is what makes that answer legible without a wider bar.
const runningDetail = (transfer, t) => {
    const label = transfer.file ?? t("servers.fileManager.transfers.progress",
        { filesDone: transfer.filesDone ?? 0, filesTotal: transfer.filesTotal ?? 0, interpolation: { escapeValue: false } });
    return t("servers.fileManager.transfers.progressPercent",
        { label, percent: transferPercent(transfer), interpolation: { escapeValue: false } });
};

// What the detail line under the transfer title says, keyed off status. Pulled out of the
// component so the branching has a test that doesn't need a DOM.
export const transferDetailText = (transfer, t) => {
    switch (transfer.status) {
        case "error":
            return transfer.connectionLost
                ? t("servers.fileManager.transfers.connectionLost")
                // React already escapes rendered text, so i18next's own HTML-escaping of the
                // interpolated value only mangles it - visibly so for a server message that
                // quotes a path.
                : t("servers.fileManager.transfers.failed", { message: transfer.message, interpolation: { escapeValue: false } });
        case "cancelled":
            return t("servers.fileManager.transfers.cancelled");
        case "done":
            return t("servers.fileManager.transfers.done",
                { count: transfer.filesTransferred ?? 0, interpolation: { escapeValue: false } });
        case "cancelling":
            return t("servers.fileManager.transfers.cancelling");
        default:
            return runningDetail(transfer, t);
    }
};

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import { convertUnits } from "../FileList/utils/fileUtils.js";

const conflictKey = (conflict) => (conflict ? `${conflict.transferId}:${conflict.file}` : null);

export const ConflictDialog = ({ conflict, onResolve, pendingCount = 0 }) => {
    const { t } = useTranslation();
    const [applyToAll, setApplyToAll] = useState(false);
    const [seenKey, setSeenKey] = useState(() => conflictKey(conflict));

    // Each question starts fresh. Adjusting state while rendering (React's documented pattern for
    // resetting state on a prop change) avoids an extra commit that a useEffect would cause. The
    // server stops asking for a transfer once applyToAll is set (spec, conflict section), so the
    // box can never be lost mid-transfer - if that ever changes, this reset becomes wrong.
    const key = conflictKey(conflict);
    if (key !== seenKey) {
        setSeenKey(key);
        setApplyToAll(false);
    }

    const choose = (choice) => onResolve?.({
        transferId: conflict.transferId, file: conflict.file, choice,
        // The server ignores applyToAll on abort; sending it anyway would only be noise.
        applyToAll: choice === "abort" ? false : applyToAll,
    });

    // Closing without answering would leave the transfer paused until the server's 120 s window
    // runs out, so the only way out is one of the three answers.
    return (
        <DialogProvider open={!!conflict} disableClosing>
            {conflict && <div className="conflict-dialog">
                <h3>{t("servers.fileManager.transferConflict.title")}</h3>
                {/* conflict.file is a filename off the wire - i18next's default HTML-escaping is
                    redundant with React's own and, for a name with an apostrophe or slash, wrong
                    to show the user. The size and count values get the same option for consistency,
                    not because they can carry special characters today. */}
                <p>{t("servers.fileManager.transferConflict.question", { file: conflict.file, interpolation: { escapeValue: false } })}</p>
                <p className="conflict-detail">
                    {t("servers.fileManager.transferConflict.source", { size: convertUnits(conflict.srcSize ?? 0), interpolation: { escapeValue: false } })}
                    {" · "}
                    {t("servers.fileManager.transferConflict.destination", { size: convertUnits(conflict.destSize ?? 0), interpolation: { escapeValue: false } })}
                </p>
                {pendingCount > 0 && <p className="conflict-detail">
                    {t("servers.fileManager.transferConflict.more", { count: pendingCount, interpolation: { escapeValue: false } })}
                </p>}
                <label className="conflict-apply-all">
                    <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
                    {t("servers.fileManager.transferConflict.applyToAll")}
                </label>
                <div className="conflict-actions">
                    <Button onClick={() => choose("overwrite")} text={t("servers.fileManager.transferConflict.overwrite")} />
                    <Button onClick={() => choose("skip")} text={t("servers.fileManager.transferConflict.skip")} />
                    <Button onClick={() => choose("abort")} text={t("servers.fileManager.transferConflict.abort")} type="danger" />
                </div>
            </div>}
        </DialogProvider>
    );
};

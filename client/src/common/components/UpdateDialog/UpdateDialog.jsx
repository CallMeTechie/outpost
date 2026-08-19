import "./styles.sass";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { installUpdate } from "@/common/utils/updater.js";
import { canSelfUpdate, packageHintKey } from "@/common/utils/updaterPolicy.js";

export const UpdateDialog = ({ open, onClose, update, installationKind }) => {
    const { t } = useTranslation();
    const [progress, setProgress] = useState(null);
    const [error, setError] = useState(null);
    const startingRef = useRef(false);

    const selfUpdating = canSelfUpdate(installationKind);
    const busy = selfUpdating && progress !== null;

    const start = async () => {
        // A ref, not the progress state: two clicks landing in the same render
        // would both read progress === null and start two installs.
        if (startingRef.current) return;
        startingRef.current = true;
        setError(null);
        setProgress(0);
        try {
            await installUpdate(update, setProgress);
        } catch (e) {
            // A failed signature check is not a transport error; it means the
            // build was not signed with our key. Both messages point at the
            // manual download, so a misclassification stays harmless.
            const rejected = String(e).toLowerCase().includes("signature");
            setError(rejected ? t("updater.rejected") : t("updater.failed"));
            setProgress(null);
        } finally {
            startingRef.current = false;
        }
    };

    return (
        <DialogProvider open={open} onClose={busy ? () => {} : onClose} disableClosing={busy}>
            <div className="update-dialog">
                <h2>{t("updater.title")}</h2>
                <p>{t("updater.subtitle", { version: update?.version })}</p>

                {error && <p className="update-error">{error}</p>}

                {!selfUpdating && <p className="update-hint">{t(packageHintKey(installationKind))}</p>}

                {busy && (
                    <div className="update-progress">
                        <div className="update-progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
                        <span>{t("updater.installing")}</span>
                    </div>
                )}

                <div className="update-actions">
                    <Button onClick={onClose} type="secondary" text={t("updater.later")} disabled={busy} />
                    {selfUpdating && (
                        <Button onClick={start} type="primary" text={t("updater.install")} disabled={busy} />
                    )}
                </div>
            </div>
        </DialogProvider>
    );
};

export default UpdateDialog;

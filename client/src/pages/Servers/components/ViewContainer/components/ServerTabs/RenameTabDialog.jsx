import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import IconInput from "@/common/components/IconInput";
import Icon from "@mdi/react";
import { mdiRenameBox, mdiCheck, mdiClose } from "@mdi/js";
import "./RenameTabDialog.sass";

// Built after ScriptRenderer/components/InputDialog.jsx, which already assembles
// DialogProvider + IconInput + Button for "ask the user for a string" - no reason to invent a
// second version of that shape. Unlike InputDialog, an empty value here is meaningful (it means
// "go back to the automatic name"), so - unlike InputDialog's submit button - Save is never
// disabled for an empty field, and the dialog closes normally on outside click / Escape instead
// of demanding an answer.
//
// Validation deliberately stays out of this component: normalizeTabName (tabIdentity.js) already
// owns trimming, control/bidi stripping and the length cap, under test. Duplicating any of that
// here would just be a second, untested copy of the same rule.
const RenameTabDialog = ({ open, initialValue, onSubmit, onClose }) => {
    const { t } = useTranslation();
    const [value, setValue] = useState("");
    // Tracks the open/closed state we've already seeded `value` for. Adjusting state during
    // render (React's own pattern for this, e.g. Servers.jsx's numberedSignature) instead of an
    // effect keyed on [open, initialValue] does two things at once: it satisfies
    // react-hooks/set-state-in-effect, and it seeds only on the false-to-true transition rather
    // than on every render while open - a live label recomputing mid-edit (a fresh
    // `initialValue` on an unrelated parent re-render) would otherwise stomp on whatever the
    // user has already typed.
    const [wasOpen, setWasOpen] = useState(false);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) setValue(initialValue || "");
    }

    const handleSubmit = () => onSubmit(value);

    const handleKeyDown = (e) => {
        if (e.key === "Enter") handleSubmit();
    };

    return (
        <DialogProvider open={open} onClose={onClose}>
            <div className="rename-tab-dialog">
                <div className="dialog-title">
                    <Icon path={mdiRenameBox} />
                    <h2>{t("servers.tabs.renameDialog.title")}</h2>
                </div>

                <div className="dialog-content">
                    <p className="dialog-description">{t("servers.tabs.renameDialog.description")}</p>
                    <IconInput
                        type="text"
                        icon={mdiRenameBox}
                        value={value}
                        setValue={setValue}
                        placeholder={t("servers.tabs.renameDialog.placeholder")}
                        onKeyDown={handleKeyDown}
                        autoFocus
                    />
                </div>

                <div className="dialog-actions">
                    <Button onClick={onClose} text={t("common.actions.cancel")} icon={mdiClose} type="secondary" />
                    <Button onClick={handleSubmit} text={t("common.actions.save")} icon={mdiCheck} />
                </div>
            </div>
        </DialogProvider>
    );
};

export default RenameTabDialog;

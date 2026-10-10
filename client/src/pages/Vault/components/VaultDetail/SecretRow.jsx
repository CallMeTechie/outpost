import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye as IconEye, EyeOff as IconEyeOff, Copy as IconCopy, Check as IconCheck } from "lucide-react";
import Button from "@/common/components/Button";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { getRequest } from "@/common/utils/RequestUtil.js";
import { copyToClipboard } from "@/common/utils/clipboard.js";

const MASK = "••••••••••••";
const HIDE_AFTER_MS = 30000;
const COPIED_MS = 2000;
const UNREADABLE = 422;

export const SecretRow = ({ itemId, field, canReveal, onUnreadable }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const [value, setValue] = useState(null);
    const [copied, setCopied] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (value === null) return;
        const timer = setTimeout(() => setValue(null), HIDE_AFTER_MS);
        return () => clearTimeout(timer);
    }, [value]);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const fetchValue = async () => {
        setBusy(true);
        try {
            return (await getRequest(`vault/items/${itemId}/secrets/${field}`)).value;
        } catch (error) {
            if (error?.code === UNREADABLE) onUnreadable();
            else sendToast(t("common.error"), error?.message || t("vault.list.error"));
            return null;
        } finally {
            setBusy(false);
        }
    };

    const toggle = async () => {
        if (value !== null) {
            setValue(null);
            return;
        }
        const revealed = await fetchValue();
        if (revealed != null) setValue(revealed);
    };

    const copy = async () => {
        const revealed = await fetchValue();
        if (revealed == null) return;
        if (await copyToClipboard(revealed)) {
            setCopied(true);
            sendToast(t("common.success"), t("vault.secret.copied"));
        } else {
            sendToast(t("common.error"), t("vault.secret.copyFailed"));
        }
    };

    return (
        <div className="vault-secret" data-ui-id="UI-VAULT-DETAIL-SECRET">
            <span className="vault-secret-label">{t(`vault.secretFields.${field}`)}</span>
            <span className="vault-secret-value">{value ?? MASK}</span>
            {canReveal ? (
                <>
                    <Button icon={value === null ? IconEye : IconEyeOff} buttonType="button" disabled={busy}
                            title={t(value === null ? "vault.secret.show" : "vault.secret.hide")} onClick={toggle} />
                    <Button icon={copied ? IconCheck : IconCopy} buttonType="button" disabled={busy}
                            title={t("vault.secret.copy")} onClick={copy} />
                    {value !== null && <span className="vault-secret-hint">{t("vault.secret.revealed")}</span>}
                    {copied && <span className="vault-secret-hint vault-secret-hint--success">{t("vault.secret.copied")}</span>}
                </>
            ) : (
                <span className="vault-secret-hint">{t("vault.secret.agentOnly")}</span>
            )}
        </div>
    );
};

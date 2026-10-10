import { useTranslation } from "react-i18next";
import Button from "@/common/components/Button";

// Only for the width of the bar. The server decides when a request has expired.
const APPROVAL_TTL_MS = 120000;

const formatRemaining = (ms) => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export const VaultApprovalCard = ({ approval, now, sending, onAnswer }) => {
    const { t } = useTranslation();
    const remaining = approval.deadline - now;
    const expired = remaining <= 0;
    const disabled = expired || sending;
    const agent = approval.agentType ? t(`vault.agents.${approval.agentType}`) : null;

    // On the card, not on the document: a dialog underneath needs Esc for itself.
    const onKeyDown = (event) => {
        if (disabled) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onAnswer("deny");
        } else if (event.key === "Enter" && event.target === event.currentTarget) {
            event.preventDefault();
            onAnswer("once");
        }
    };

    return (
        <div className={`vault-approval-card${expired ? " is-expired" : ""}`} tabIndex={0} role="group"
             aria-label={t("vault.approval.title")} onKeyDown={onKeyDown}>
            <h3>{t("vault.approval.title")}</h3>
            {agent && (
                <div className="vault-approval-who">
                    {approval.entryName
                        ? t("vault.approval.who", { agent, server: approval.entryName, interpolation: { escapeValue: false } })
                        : agent}
                </div>
            )}
            {approval.impersonated && <div className="vault-approval-who">{t("vault.approval.impersonated")}</div>}
            <div className="vault-approval-target">{approval.item}</div>
            <div className="vault-approval-target">{approval.target}</div>
            {(sending || expired) && (
                <div className="vault-approval-status" role="status">
                    {t(expired ? "vault.approval.expired" : "vault.approval.sending")}
                </div>
            )}
            <div className="vault-approval-actions">
                <Button type="primary" text={t("vault.approval.actions.once")} disabled={disabled} loading={sending}
                        onClick={() => onAnswer("once")} />
                {!approval.impersonated && (
                    <Button text={t("vault.approval.actions.session")} disabled={disabled} onClick={() => onAnswer("session")} />
                )}
                <Button text={t("vault.approval.actions.deny")} disabled={disabled} onClick={() => onAnswer("deny")} />
            </div>
            <div className="vault-approval-timer">{formatRemaining(remaining)}</div>
            <div className="vault-approval-bar">
                <i style={{ width: `${Math.min(1, Math.max(0, remaining / APPROVAL_TTL_MS)) * 100}%` }} />
            </div>
        </div>
    );
};

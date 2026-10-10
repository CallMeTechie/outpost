import "./styles.sass";
import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { StateStreamContext, STATE_TYPES } from "@/common/contexts/StateStreamContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
import { postRequest } from "@/common/utils/RequestUtil.js";
import { VaultApprovalCard } from "./VaultApprovalCard.jsx";

const EXPIRED_VISIBLE_MS = 5000;
const DELIVERY_GRACE_MS = 1000;

export const VaultApprovalStack = () => {
    const { t } = useTranslation();
    const { registerHandler } = useContext(StateStreamContext);
    const { sendToast } = useToast();
    const { impersonating } = useVaultAvailable();
    const [approvals, setApprovals] = useState([]);
    const [now, setNow] = useState(() => Date.now());
    const [sending, setSending] = useState(() => new Set());
    const [answered, setAnswered] = useState(() => new Set());

    useEffect(() => registerHandler(STATE_TYPES.VAULT_APPROVALS, (list) => {
        const current = Date.now();
        const next = (Array.isArray(list) ? list : [])
            .map((approval) => ({ ...approval, deadline: current + approval.remainingMs }));
        const ids = new Set(next.map((approval) => approval.id));
        // The server drops a request the moment it times out. Keeping it here lets the card
        // show its expired state for five seconds; one answered elsewhere goes at once.
        setApprovals((prev) => [
            ...next,
            ...prev.filter((approval) => !ids.has(approval.id)
                && approval.deadline <= current + DELIVERY_GRACE_MS
                && approval.deadline + EXPIRED_VISIBLE_MS > current),
        ]);
        setNow(current);
    }), [registerHandler]);

    const visible = approvals
        .filter((approval) => !answered.has(approval.id) && now < approval.deadline + EXPIRED_VISIBLE_MS)
        .sort((a, b) => b.deadline - a.deadline);
    const hasCards = visible.length > 0;

    useEffect(() => {
        if (!hasCards) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [hasCards]);

    const markAnswered = (id) => setAnswered((prev) => new Set(prev).add(id));

    const answer = async (id, decision) => {
        setSending((prev) => new Set(prev).add(id));
        try {
            await postRequest(`vault/approvals/${id}`, { decision });
            markAnswered(id);
        } catch (err) {
            if ([404, 409, 410].includes(err?.code)) markAnswered(id);
            else sendToast(t("common.error"), err?.message || t("common.error"));
        } finally {
            setSending((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    if (impersonating || !hasCards) return null;

    return createPortal(
        <div className="vault-approval-stack" data-ui-id="UI-VAULT-APPROVAL-CARD">
            {visible.length > 1 && (
                <div className="vault-approval-count">{t("vault.approval.pending", { count: visible.length })}</div>
            )}
            {visible.map((approval) => (
                <VaultApprovalCard key={approval.id} approval={approval} now={now}
                                   sending={sending.has(approval.id)}
                                   onAnswer={(decision) => answer(approval.id, decision)} />
            ))}
        </div>,
        document.body,
    );
};

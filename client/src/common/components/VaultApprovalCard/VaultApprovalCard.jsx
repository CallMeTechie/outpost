import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PenLine as IconPenLine, SquareTerminal as IconSquareTerminal } from "lucide-react";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import { formatBytes } from "@/common/utils/formatUtils.js";
import { keyAlgorithmLabel } from "@/common/utils/sshHostKey.js";

// Only for the width of the bar. The server decides when a request has expired.
const APPROVAL_TTL_MS = 120000;
const FILL_TOOLS = ["browser_fill_secret", "browser_fill_credential"];
const SSH_TOOLS = { ssh_exec: "exec", ssh_put: "put", ssh_get: "get" };
const COMMAND_LINES = 20;
const COMMAND_CHARS = 1200;

const formatRemaining = (ms) => {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const sshAddress = ({ user, host, port }) =>
    `${user}@${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;

const isLong = (command) => command.length > COMMAND_CHARS || command.split("\n").length > COMMAND_LINES;

const Command = ({ command, folded, onExpand }) => {
    const { t } = useTranslation();
    const lines = command.split("\n");
    return (
        <div className="vault-approval-command" data-ui-id="UI-VAULT-APPROVAL-COMMAND">
            <pre>{folded ? lines.slice(0, COMMAND_LINES).join("\n").slice(0, COMMAND_CHARS) : command}</pre>
            {folded && (
                <>
                    <button type="button" className="vault-approval-more" onClick={onExpand}>
                        {lines.length > COMMAND_LINES
                            ? t("vault.approval.command.expand", { lines: lines.length })
                            : t("vault.approval.command.expandChars", { chars: command.length })}
                    </button>
                    <div className="vault-approval-locked">{t("vault.approval.command.locked")}</div>
                </>
            )}
        </div>
    );
};

export const VaultApprovalCard = ({ approval, now, sending, onAnswer }) => {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const remaining = approval.deadline - now;
    const expired = remaining <= 0;
    const disabled = expired || sending;
    const command = typeof approval.command === "string" ? approval.command : null;
    const folded = command !== null && !expanded && isLong(command);
    const grantDisabled = disabled || folded;
    const agent = approval.agentType ? t(`vault.agents.${approval.agentType}`) : null;
    const fillKey = approval.field ? "vault.approval.target.fillField" : "vault.approval.target.fill";
    const sshTool = approval.sshTarget && SSH_TOOLS[approval.tool];
    const toolLine = sshTool
        ? [t(`vault.approval.ssh.${sshTool}`), approval.sshTarget.name, sshAddress(approval.sshTarget)].join(" · ")
        : approval.target && (FILL_TOOLS.includes(approval.tool)
            ? t(fillKey, { origin: approval.target, field: approval.field, interpolation: { escapeValue: false } })
            : approval.target);
    const sessionOffered = !approval.impersonated
        && (sshTool ? approval.allowSession === true : approval.allowSession !== false);

    // On the card, not on the document: a dialog underneath needs Esc for itself.
    const onKeyDown = (event) => {
        if (disabled) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onAnswer("deny");
        } else if (event.key === "Enter" && event.target === event.currentTarget && !folded) {
            event.preventDefault();
            onAnswer("once");
        }
    };

    return (
        <div className={`vault-approval-card${expired ? " is-expired" : ""}`} tabIndex={0} role="group"
             aria-label={t("vault.approval.title")} onKeyDown={onKeyDown}>
            <div className="vault-approval-head">
                <h3>{t("vault.approval.title")}</h3>
                {approval.access === "write" && (
                    <span className="vault-approval-write" data-ui-id="UI-VAULT-APPROVAL-WRITE">
                        <Icon icon={IconPenLine} />
                        {t("vault.approval.write")}
                    </span>
                )}
                {approval.access === "exec" && (
                    <span className="vault-approval-exec" data-ui-id="UI-VAULT-APPROVAL-EXEC">
                        <Icon icon={IconSquareTerminal} />
                        {t("vault.approval.exec")}
                    </span>
                )}
            </div>
            {agent && (
                <div className="vault-approval-who">
                    {approval.entryName
                        ? t("vault.approval.who", { agent, server: approval.entryName, interpolation: { escapeValue: false } })
                        : agent}
                </div>
            )}
            {approval.impersonated && <div className="vault-approval-who">{t("vault.approval.impersonated")}</div>}
            <div className="vault-approval-target">{approval.item}</div>
            {toolLine && <div className="vault-approval-target">{toolLine}</div>}
            {approval.file && (
                <div className="vault-approval-target">
                    {approval.file.from} → {approval.file.to} · {approval.file.bytes == null
                        ? t("vault.approval.ssh.sizeLater")
                        : formatBytes(approval.file.bytes)}
                </div>
            )}
            {approval.hostKey?.new === true && (
                <div className="vault-approval-hostkey" data-ui-id="UI-VAULT-APPROVAL-HOSTKEY">
                    <strong>{t("vault.approval.hostKey.title")}</strong>
                    {" — "}{keyAlgorithmLabel(approval.hostKey.algorithm)}{" "}
                    <span className="vault-approval-fingerprint">{approval.hostKey.fingerprint}</span>
                    {". "}{t("vault.approval.hostKey.advice")}
                </div>
            )}
            {command !== null && <Command command={command} folded={folded} onExpand={() => setExpanded(true)} />}
            {(sending || expired) && (
                <div className="vault-approval-status" role="status">
                    {t(expired ? "vault.approval.expired" : "vault.approval.sending")}
                </div>
            )}
            <div className="vault-approval-actions">
                <Button type="primary" text={t("vault.approval.actions.once")} disabled={grantDisabled} loading={sending}
                        onClick={() => onAnswer("once")} />
                {sessionOffered && (
                    <Button text={t("vault.approval.actions.session")} disabled={grantDisabled} onClick={() => onAnswer("session")} />
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

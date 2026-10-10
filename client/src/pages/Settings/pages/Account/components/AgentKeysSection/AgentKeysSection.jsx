import "./styles.sass";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy as IconCopy, KeyRound as IconKeyRound, Pencil as IconPencil } from "lucide-react";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import ActionConfirmDialog from "@/common/components/ActionConfirmDialog";
import AgentAccessDialog from "@/pages/Servers/components/AgentAccessDialog";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
import { deleteRequest, getRequest } from "@/common/utils/RequestUtil.js";
import { copyToClipboard } from "@/common/utils/clipboard.js";
import { formatTimeAgo } from "@/common/utils/timeAgo.js";

const raw = { interpolation: { escapeValue: false } };

export const AgentKeysSection = () => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const { getServerById } = useContext(ServerContext);
    const { enabled, impersonating } = useVaultAvailable();
    const [keys, setKeys] = useState([]);
    const [revokeOpen, setRevokeOpen] = useState(false);
    const [revokeTarget, setRevokeTarget] = useState(null);
    const [editEntryId, setEditEntryId] = useState(null);
    const [revokeOutcome, setRevokeOutcome] = useState(null);
    const revoking = useRef(false);

    const load = useCallback(async () => {
        try {
            const data = await getRequest("vault/agent-keys");
            setKeys((data.keys || []).filter((key) => !key.pending));
        } catch (err) {
            console.error("Failed to load agent keys:", err);
        }
    }, []);

    useEffect(() => {
        if (enabled) load();
    }, [enabled, load]);

    const serverName = (entryId) => getServerById(entryId)?.name ?? String(entryId);
    const agentLabel = (type) => t(`vault.agents.${type}`);

    const groups = [...keys.reduce((map, key) => map.set(key.entryId, [...(map.get(key.entryId) || []), key]), new Map())];

    const confirmRevoke = (key) => {
        setRevokeTarget(key);
        setRevokeOpen(true);
    };

    const revoke = async () => {
        if (!revokeTarget || revoking.current) return;
        revoking.current = true;
        setRevokeOutcome(null);
        try {
            const data = await deleteRequest(`vault/agent-keys/${revokeTarget.id}`);
            if (data.registration === "foreign" || data.registration === "unknown") {
                setRevokeOutcome({ registration: data.registration, server: serverName(revokeTarget.entryId), commands: data.commands ?? null });
            }
            load();
        } catch (err) {
            if (err?.code === 404) load();
            else sendToast(t("common.error"), err?.message || t("common.error"));
        } finally {
            revoking.current = false;
            setRevokeTarget(null);
        }
    };

    const copyCommands = async () => {
        if (!(await copyToClipboard(revokeOutcome.commands))) {
            sendToast(t("common.error"), t("settings.account.apiKeys.copyError"));
        }
    };

    const binding = (key) => {
        if (!key.ipBinding) {
            return (
                <>
                    <span>{t("settings.account.agentKeys.unbound")}</span>
                    <span className="agent-key-anywhere">{t("settings.account.agentKeys.anywhere")}</span>
                </>
            );
        }
        const address = [getServerById(key.entryId)?.ip, ...key.allowedCidrs].filter(Boolean).join(", ");
        return <span className="agent-key-address">{t("settings.account.agentKeys.boundTo", { address, ...raw })}</span>;
    };

    if (!enabled) return null;

    return (
        <div className="account-section agent-keys-section" data-ui-id="UI-API-KEYS-AGENTS">
            <ActionConfirmDialog
                open={revokeOpen}
                setOpen={setRevokeOpen}
                onConfirm={revoke}
                text={revokeTarget ? t("settings.account.agentKeys.revokeConfirm", {
                    agent: agentLabel(revokeTarget.agentType), server: serverName(revokeTarget.entryId), ...raw,
                }) : undefined}
            />
            <AgentAccessDialog open={editEntryId !== null} entryId={editEntryId}
                               onClose={() => { setEditEntryId(null); load(); }} />
            <div className="section-header">
                <div className="header-content">
                    <h2><Icon icon={IconKeyRound} size={0.8} className="agent-keys-title-icon" />{t("settings.account.agentKeys.sectionTitle")}</h2>
                    <p>{t("settings.account.agentKeys.sectionDescription")}</p>
                </div>
            </div>
            {revokeOutcome && (
                <div className="agent-keys-revoked" role="status">
                    <p>
                        {revokeOutcome.registration === "foreign"
                            ? t("settings.account.agentKeys.revokedForeign", { server: revokeOutcome.server, ...raw })
                            : t("settings.account.agentKeys.revokedUnknown")}
                    </p>
                    {revokeOutcome.commands && (
                        <div className="agent-keys-command">
                            <pre>{revokeOutcome.commands}</pre>
                            <Button type="secondary" icon={IconCopy} text={t("servers.agentAccess.result.copy")}
                                    onClick={copyCommands} />
                        </div>
                    )}
                </div>
            )}
            {groups.length === 0 ? (
                <div className="settings-list">
                    <div className="list-empty"><p>{t("settings.account.agentKeys.empty")}</p></div>
                </div>
            ) : (
                <div className="agent-key-groups">
                    {groups.map(([entryId, entryKeys]) => (
                        <div className="agent-key-group" key={entryId}>
                            <div className="agent-key-group-head">
                                <span className="agent-key-group-name">{serverName(entryId)}</span>
                                {!impersonating && (
                                    <Button type="secondary" icon={IconPencil} text={t("settings.account.agentKeys.edit")}
                                            onClick={() => setEditEntryId(entryId)} />
                                )}
                            </div>
                            <div className="settings-list">
                                {entryKeys.map((key) => (
                                    <div className="settings-list-item" key={key.id}>
                                        <div className="item-info">
                                            <Icon icon={IconKeyRound} className="item-icon" />
                                            <div className="item-details">
                                                <h3>{agentLabel(key.agentType)}</h3>
                                                <p className="item-meta agent-key-meta">
                                                    <span>
                                                        {key.lastUsedAt
                                                            ? t("settings.account.agentKeys.lastUsed", { time: formatTimeAgo(key.lastUsedAt, t), ...raw })
                                                            : t("settings.account.apiKeys.neverUsed")}
                                                    </span>
                                                    {binding(key)}
                                                </p>
                                            </div>
                                        </div>
                                        {!impersonating && (
                                            <div className="item-actions">
                                                <Button type="danger" text={t("settings.account.agentKeys.revoke")}
                                                        onClick={() => confirmRevoke(key)} />
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

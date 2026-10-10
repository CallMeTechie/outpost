import "./styles.sass";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil as IconPencil, Trash2 as IconTrash2, Shield as IconShield, ShieldOff as IconShieldOff, Lock as IconLock } from "lucide-react";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import ActionConfirmDialog from "@/common/components/ActionConfirmDialog";
import { formatTimeAgo } from "@/common/utils/timeAgo.js";
import { VAULT_TYPES, detailRows } from "../../vaultTypes.js";
import { SecretRow } from "./SecretRow.jsx";

export const VaultDetail = ({ item, impersonating, onEdit, onDelete }) => {
    const { t } = useTranslation();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [unreadableId, setUnreadableId] = useState(null);

    if (!item) {
        return (
            <section className="vault-detail vault-detail--empty" data-ui-id="UI-VAULT-DETAIL">
                <p>{t("vault.detail.empty")}</p>
            </section>
        );
    }

    const type = VAULT_TYPES[item.type];
    const owner = item.organizationId ? item.ownerName : t("vault.scope.personal");
    const rows = detailRows(item);
    const lastUsed = item.lastUsedAt ? ` · ${t("vault.policy.lastUsed", { time: formatTimeAgo(item.lastUsedAt, t), interpolation: { escapeValue: false } })}` : "";

    return (
        <section className="vault-detail" data-ui-id="UI-VAULT-DETAIL">
            <header className="vault-detail-head">
                <div>
                    <h3>{item.name}</h3>
                    <div className="vault-detail-meta">
                        <Icon icon={type?.icon ?? IconLock} />
                        <span>{type ? t(type.labelKey) : item.type} · {owner}</span>
                    </div>
                    {item.description && <p className="vault-detail-description">{item.description}</p>}
                </div>
                {item.canManage && (
                    <div className="vault-detail-actions" data-ui-id="UI-VAULT-DETAIL-ACTIONS">
                        <Button text={t("vault.detail.edit")} icon={IconPencil} type="secondary" onClick={() => onEdit(item)} />
                        <Button text={t("vault.detail.delete")} icon={IconTrash2} type="danger" onClick={() => setConfirmOpen(true)} />
                    </div>
                )}
            </header>

            {(item.unreadable || unreadableId === item.id) && (
                <p className="vault-detail-error" role="alert">{t("vault.detail.error")}</p>
            )}

            {rows.length > 0 && (
                <div className="vault-detail-section" data-ui-id="UI-VAULT-DETAIL-FIELDS">
                    <h4>{t("vault.detail.fields")}</h4>
                    <dl className="vault-detail-fields">
                        {rows.map(([labelKey, value]) => (
                            <div key={labelKey}><dt>{t(labelKey)}</dt><dd>{value}</dd></div>
                        ))}
                    </dl>
                </div>
            )}

            {item.secretFields.length > 0 && (
                <div className="vault-detail-section">
                    <h4>{t("vault.detail.secrets")}</h4>
                    {item.secretFields.map((field) => (
                        <SecretRow key={`${item.id}:${field}`} itemId={item.id} field={field}
                                   canReveal={item.canReveal && !impersonating}
                                   onUnreadable={() => setUnreadableId(item.id)} />
                    ))}
                </div>
            )}

            <div className="vault-detail-section">
                <h4>{t("vault.detail.scope")}</h4>
                {item.allServers || item.bindings.length > 0 ? (
                    <ul className="vault-detail-chips" data-ui-id="UI-VAULT-DETAIL-SCOPE">
                        {item.allServers
                            ? <li>{t("vault.bindings.allServers")}</li>
                            : item.bindings.map((binding) => (
                                <li key={`${binding.kind}:${binding.targetId}`}>{t(`vault.bindings.${binding.kind}`)} {binding.label ?? binding.targetId}</li>
                            ))}
                    </ul>
                ) : (
                    <p className="vault-detail-hint" data-ui-id="UI-VAULT-DETAIL-SCOPE">{t("vault.bindings.empty")}</p>
                )}
            </div>

            <div className="vault-detail-section">
                <p className={`vault-detail-policy${item.approvalRequired ? "" : " vault-detail-policy--off"}`}
                   data-ui-id="UI-VAULT-DETAIL-POLICY">
                    <Icon icon={item.approvalRequired ? IconShield : IconShieldOff} />
                    {t(item.approvalRequired ? "vault.policy.required" : "vault.policy.notRequired")}{lastUsed}
                </p>
            </div>

            <ActionConfirmDialog open={confirmOpen} setOpen={setConfirmOpen} onConfirm={() => onDelete(item)}
                                 text={t("vault.detail.deleteConfirm", { name: item.name, interpolation: { escapeValue: false } })} />
        </section>
    );
};

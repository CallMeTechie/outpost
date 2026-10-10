import "./styles.sass";
import { useTranslation } from "react-i18next";
import { Plus as IconPlus, Shield as IconShield, Lock as IconLock } from "lucide-react";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import { VAULT_TYPES, itemSubject } from "../../vaultTypes.js";

export const VaultList = ({ items, loading, failed, ownerEmpty, selectedId, onSelect, canCreate, onCreate }) => {
    const { t } = useTranslation();

    if (loading) {
        return (
            <div className="vault-list vault-list--loading" data-ui-id="UI-VAULT-LIST" aria-busy="true">
                {[0, 1, 2].map((row) => <div key={row} className="vault-list-skeleton"><span /><span /></div>)}
            </div>
        );
    }

    if (failed) {
        return (
            <div className="vault-list" data-ui-id="UI-VAULT-LIST">
                <p className="vault-list-note vault-list-note--error" role="alert">{t("vault.list.error")}</p>
            </div>
        );
    }

    if (ownerEmpty) {
        return (
            <div className="vault-list" data-ui-id="UI-VAULT-LIST">
                <div className="vault-list-note">
                    <p>{t("vault.list.empty")}</p>
                    {canCreate && <Button text={t("vault.page.addItem")} icon={IconPlus} type="primary" onClick={onCreate} />}
                </div>
            </div>
        );
    }

    return (
        <ul className="vault-list" data-ui-id="UI-VAULT-LIST" role="listbox" aria-label={t("vault.list.title")}>
            {items.map((item) => {
                const subject = itemSubject(item);
                return (
                    <li key={item.id} role="option" aria-selected={item.id === selectedId}
                        className={`vault-row${item.id === selectedId ? " vault-row--selected" : ""}`}
                        onClick={() => onSelect(item.id)}>
                        <Icon icon={VAULT_TYPES[item.type]?.icon ?? IconLock} className="vault-row-type" />
                        <span className="vault-row-text">
                            <span className="vault-row-name">{item.name}</span>
                            {subject && <span className="vault-row-subject">{subject}</span>}
                        </span>
                        {item.approvalRequired && <Icon icon={IconShield} className="vault-row-shield" title={t("vault.policy.required")} />}
                    </li>
                );
            })}
        </ul>
    );
};

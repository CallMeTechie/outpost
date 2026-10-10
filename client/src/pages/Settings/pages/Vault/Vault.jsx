import "./styles.sass";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
    Check as IconCheck, CircleAlert as IconCircleAlert, Link as IconLink, Save as IconSave,
    TriangleAlert as IconTriangleAlert,
} from "lucide-react";
import { getRequest, patchRequest } from "@/common/utils/RequestUtil.js";
import Button from "@/common/components/Button";
import IconInput from "@/common/components/IconInput";
import Icon from "@/common/components/Icon";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";

const KEY_STATUS = {
    active: { icon: IconCheck, text: null },
    missing: { icon: IconTriangleAlert, text: "key.missingText" },
    mismatch: { icon: IconCircleAlert, text: "key.mismatchText" },
};

export const isValidAgentUrl = (value) => value === "" || /^https?:\/\/\S+$/i.test(value);

const SettingItem = ({ title, description, dataUiId, children }) => (
    <div className="setting-item" data-ui-id={dataUiId}>
        <div className="setting-label">
            <h4>{title}</h4>
            {description && <p>{description}</p>}
        </div>
        {children}
    </div>
);

export const Vault = () => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const { refresh } = useVaultAvailable();
    const [settings, setSettings] = useState(null);
    const [agentUrl, setAgentUrl] = useState("");
    const [saving, setSaving] = useState(false);

    const s = (key) => t(`settings.vault.${key}`);

    useEffect(() => {
        getRequest("vault/settings")
            .then((data) => {
                setSettings(data);
                setAgentUrl(data.agentUrl ?? "");
            })
            .catch(() => sendToast(t("common.error"), t("settings.vault.errors.loadSettings")));
    }, [sendToast, t]);

    const trimmed = agentUrl.trim();
    const urlInvalid = !isValidAgentUrl(trimmed);

    const save = async () => {
        try {
            setSaving(true);
            const data = await patchRequest("vault/settings", { agentUrl: trimmed || null });
            setSettings(data);
            setAgentUrl(data.agentUrl ?? "");
            refresh();
            sendToast(t("common.success"), s("saveSuccess"));
        } catch {
            sendToast(t("common.error"), s("errors.saveSettings"));
        } finally {
            setSaving(false);
        }
    };

    if (!settings) return <div className="vault-settings-loading">{s("loading")}</div>;

    const statusKey = KEY_STATUS[settings.keyStatus] ? settings.keyStatus : "missing";
    const status = KEY_STATUS[statusKey];

    return (
        <div className="vault-settings" data-ui-id="UI-VAULT-SETTINGS">
            <div className="settings-section">
                <h2>{s("title")}</h2>
                <p>{s("description")}</p>
                <SettingItem title={s("key.title")} dataUiId="UI-VAULT-SETTINGS-KEY">
                    <div className="vault-key-status">
                        <span className={`vault-key-pill is-${statusKey}`}>
                            <Icon icon={status.icon} />
                            {s(`key.${statusKey}`)}
                        </span>
                        {status.text && <p>{s(status.text)}</p>}
                    </div>
                </SettingItem>
                <SettingItem title={s("agentUrl.title")} description={s("agentUrl.description")} dataUiId="UI-VAULT-SETTINGS-URL">
                    <div className={`setting-input${urlInvalid ? " is-error" : ""}`}>
                        <IconInput icon={IconLink} value={agentUrl} setValue={setAgentUrl} />
                        {urlInvalid && <p className="vault-url-error" role="alert">{s("agentUrl.invalid")}</p>}
                    </div>
                </SettingItem>
                {settings.trustProxyUnsafe && (
                    <div className="vault-proxy-warning" data-ui-id="UI-VAULT-SETTINGS-PROXY" role="alert">
                        <Icon icon={IconTriangleAlert} />
                        <p>{s("proxy.warning")}</p>
                    </div>
                )}
            </div>
            <div className="settings-actions">
                <Button text={s("saveSettings")} icon={IconSave} onClick={save} disabled={saving || urlInvalid}
                        type="primary" dataUiId="UI-VAULT-SETTINGS-SAVE" />
            </div>
        </div>
    );
};

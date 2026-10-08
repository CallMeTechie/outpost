import "./styles.sass";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getRequest, patchRequest } from "@/common/utils/RequestUtil.js";
import Button from "@/common/components/Button";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import IconInput from "@/common/components/IconInput";
import { Save as IconSave, Link as IconLink, Server as IconServer } from "lucide-react";

const SettingItem = ({ title, description, children }) => (
    <div className="setting-item">
        <div className="setting-label"><h4>{title}</h4><p>{description}</p></div>
        {children}
    </div>
);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const Browser = () => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const [settings, setSettings] = useState(null);
    const [saving, setSaving] = useState(false);

    const s = (key) => t(`settings.browser.${key}`);
    const set = useCallback((field, value) => setSettings((prev) => ({ ...prev, [field]: value })), []);

    useEffect(() => {
        getRequest("browser/settings")
            .then(setSettings)
            .catch(() => sendToast(t("common.error"), t("settings.browser.errors.loadSettings")));
    }, [sendToast, t]);

    const save = async () => {
        try {
            setSaving(true);
            setSettings(await patchRequest("browser/settings", settings));
            sendToast(t("common.success"), s("saveSuccess"));
        } catch {
            sendToast(t("common.error"), s("errors.saveSettings"));
        } finally {
            setSaving(false);
        }
    };

    if (!settings) return <div className="browser-settings-loading">{s("loading")}</div>;

    return (
        <div className="browser-settings">
            <div className="settings-section">
                <h2>{s("title")}</h2>
                <p>{s("description")}</p>
                <SettingItem title={s("enabled.title")} description={s("enabled.description")}>
                    <ToggleSwitch id="browser-enabled" checked={settings.enabled} onChange={(value) => set("enabled", value)} />
                </SettingItem>
                <SettingItem title={s("launcherUrl.title")} description={s("launcherUrl.description")}>
                    <div className="setting-input">
                        <IconInput icon={IconLink} value={settings.launcherUrl} setValue={(value) => set("launcherUrl", value)} />
                    </div>
                </SettingItem>
                <SettingItem title={s("callbackHost.title")} description={s("callbackHost.description")}>
                    <div className="setting-input">
                        <IconInput icon={IconServer} value={settings.callbackHost} setValue={(value) => set("callbackHost", value)} />
                    </div>
                </SettingItem>
                <SettingItem title={s("maxSessions.title")} description={s("maxSessions.description")}>
                    <div className="setting-input number-input">
                        <input type="number" min={1} max={32} value={settings.maxSessions}
                               onChange={(e) => set("maxSessions", clamp(parseInt(e.target.value, 10) || 1, 1, 32))} />
                        <span className="unit">{s("sessions")}</span>
                    </div>
                </SettingItem>
                <SettingItem title={s("idleMinutes.title")} description={s("idleMinutes.description")}>
                    <div className="setting-input number-input">
                        <input type="number" min={1} max={1440} value={settings.idleMinutes}
                               onChange={(e) => set("idleMinutes", clamp(parseInt(e.target.value, 10) || 1, 1, 1440))} />
                        <span className="unit">{s("minutes")}</span>
                    </div>
                </SettingItem>
            </div>
            <div className="settings-actions">
                <Button text={s("saveSettings")} icon={IconSave} onClick={save} disabled={saving} type="primary" />
            </div>
        </div>
    );
};

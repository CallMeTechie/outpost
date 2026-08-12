import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiMicrosoft, mdiKeyVariant, mdiIdentifier, mdiLinkVariant } from "@mdi/js";
import IconInput from "@/common/components/IconInput";
import Button from "@/common/components/Button";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import ActionConfirmDialog from "@/common/components/ActionConfirmDialog";
import { deleteRequest, getRequest, putRequest } from "@/common/utils/RequestUtil.js";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import "./styles.sass";

const defaultRedirectUri = () => `${window.location.origin}/api/microsoft/callback`;

export const Microsoft = () => {
    const { t } = useTranslation();
    const { sendToast } = useToast();

    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [redirectUri, setRedirectUri] = useState(defaultRedirectUri());
    const [enabled, setEnabled] = useState(false);
    const [exists, setExists] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);

    const load = async () => {
        try {
            const app = await getRequest("microsoft/app");
            if (!app) return;

            setExists(true);
            setClientId(app.clientId || "");
            setClientSecret(app.clientSecret || "");
            setRedirectUri(app.redirectUri || defaultRedirectUri());
            setEnabled(Boolean(app.enabled));
        } catch (error) {
            console.error("Failed to load the Microsoft registration:", error);
        }
    };

    useEffect(() => { load(); }, []);

    const save = async (nextEnabled = enabled) => {
        const previousEnabled = enabled;
        try {
            const app = await putRequest("microsoft/app", {
                clientId: clientId.trim(),
                clientSecret,
                redirectUri: redirectUri.trim(),
                enabled: nextEnabled,
            });

            setExists(true);
            setEnabled(Boolean(app.enabled));
            setClientSecret(app.clientSecret || "");
            sendToast(t("common.success"), t("settings.microsoft.saved"));
        } catch (error) {
            // The toggle switch sets `enabled` optimistically before the request resolves. If the
            // save is refused (e.g. no usable secret yet), the toggle must fall back to what is
            // actually persisted — a registration that looks enabled but was never saved is worse
            // than one that clearly is not.
            setEnabled(previousEnabled);
            sendToast(t("common.error"), error.message);
        }
    };

    const remove = async () => {
        try {
            await deleteRequest("microsoft/app");
            setExists(false);
            setClientId("");
            setClientSecret("");
            setRedirectUri(defaultRedirectUri());
            setEnabled(false);
            sendToast(t("common.success"), t("settings.microsoft.removed"));
        } catch (error) {
            sendToast(t("common.error"), error.message);
        }
    };

    return (
        <div className="microsoft-page">
            <ActionConfirmDialog open={deleteOpen} setOpen={setDeleteOpen} onConfirm={remove}
                                 text={t("settings.microsoft.confirmDelete")} />

            <div className="account-section">
                <div className="section-header">
                    <div className="header-content">
                        <h2><Icon path={mdiMicrosoft} size={0.8} style={{ marginRight: "8px" }} />
                            {t("settings.microsoft.title")}</h2>
                        <p>{t("settings.microsoft.description")}</p>
                    </div>
                    <div className="ms-enabled-toggle">
                        <label htmlFor="ms-enabled">{t("settings.microsoft.enabled")}</label>
                        <ToggleSwitch id="ms-enabled" checked={enabled}
                                      onChange={(value) => { setEnabled(value); save(value); }} />
                    </div>
                </div>

                <div className="section-inner ms-form">
                    <p className="ms-hint">{t("settings.microsoft.enabledHint")}</p>

                    <div className="form-group">
                        <label htmlFor="ms-client-id">{t("settings.microsoft.clientId")}</label>
                        {/* A text field directly above a password field is what browsers read as a
                            login form, and they fill it with the saved Nexterm credentials. Same
                            treatment as DirectConnectDialog: its own name, and "new-password" on the
                            secret below — "off" is ignored on password-type inputs. */}
                        <IconInput id="ms-client-id" name="ms-client-id" autoComplete="off"
                                   icon={mdiIdentifier} value={clientId} setValue={setClientId} />
                    </div>

                    <div className="form-group">
                        <label htmlFor="ms-client-secret">{t("settings.microsoft.clientSecret")}</label>
                        <IconInput id="ms-client-secret" name="ms-client-secret" autoComplete="new-password"
                                   icon={mdiKeyVariant} type="password"
                                   value={clientSecret} setValue={setClientSecret} />
                        <small>{t("settings.microsoft.clientSecretKeep")}</small>
                    </div>

                    <div className="form-group">
                        <label htmlFor="ms-redirect-uri">{t("settings.microsoft.redirectUri")}</label>
                        <IconInput id="ms-redirect-uri" name="ms-redirect-uri" autoComplete="off"
                                   icon={mdiLinkVariant}
                                   value={redirectUri} setValue={setRedirectUri} />
                        <small>{t("settings.microsoft.redirectUriHint")}</small>
                    </div>

                    <p className="ms-hint">{t("settings.microsoft.accountTypesHint")}</p>
                    <p className="ms-hint">{t("settings.microsoft.permissionsHint")}</p>

                    <div className="ms-actions">
                        <Button text={t("settings.microsoft.save")} onClick={() => save()} />
                        {exists && <Button text={t("settings.microsoft.delete")} type="secondary"
                                           onClick={() => setDeleteOpen(true)} />}
                    </div>
                </div>
            </div>
        </div>
    );
};

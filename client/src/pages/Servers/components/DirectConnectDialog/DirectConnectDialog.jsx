import { DialogProvider } from "@/common/components/Dialog";
import "./styles.sass";
import { useEffect, useState, useCallback, useMemo } from "react";
import Button from "@/common/components/Button";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useTranslation } from "react-i18next";
import {
    mdiAccountCircleOutline,
    mdiFileUploadOutline,
    mdiLockOutline,
} from "@mdi/js";
import Input from "@/common/components/IconInput";
import SelectBox from "@/common/components/SelectBox";
import { getFieldConfig } from "@/pages/Servers/components/ServerDialog/utils/fieldConfig.js";

export const DirectConnectDialog = ({ open, onClose, onConnect, server }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();

    const protocol = server?.protocol ?? server?.config?.protocol;
    const fieldConfig = useMemo(() => getFieldConfig("server", protocol), [protocol]);
    const allowedAuthTypes = fieldConfig.allowedAuthTypes || ["password", "ssh", "both"];
    const defaultAuthType = allowedAuthTypes[0] || "password";

    const [username, setUsername] = useState("");
    const [authType, setAuthType] = useState(defaultAuthType);
    const [password, setPassword] = useState("");
    const [sshKey, setSshKey] = useState(null);
    const [passphrase, setPassphrase] = useState("");
    // UI-DIRECT-CONNECT-GO carries a loading state. It holds from the click
    // until onConnect reports back, which is the round trip of
    // POST /connections -- not a claim that the SSH login succeeded, since the
    // server answers before attempting it.
    const [connecting, setConnecting] = useState(false);
    // UI-DIRECT-CONNECT-AUTH, state error: shown in place, not only as a toast,
    // and the dialog stays open so the input can be corrected.
    //
    // Honest boundary: this catches what POST /connections refuses (403, 400,
    // 500). It does NOT catch a rejected SSH login -- the server answers 201
    // with a sessionId before the login is even attempted, and the rejection
    // surfaces in the session tab. The manifest's copy "Anmeldung abgelehnt."
    // therefore does not fit this branch; the real server message is shown
    // instead of claiming a cause we cannot know.
    const [authError, setAuthError] = useState(null);

    const allAuthOptions = [
        { label: t("servers.dialog.identities.passwordOnly"), value: "password-only" },
        { label: t("servers.dialog.identities.userPassword"), value: "password" },
        { label: t("servers.dialog.identities.sshKey"), value: "ssh" },
        { label: t("servers.dialog.identities.both"), value: "both" },
    ];
    
    const authOptions = useMemo(() => 
        allAuthOptions.filter(opt => allowedAuthTypes.includes(opt.value)),
        [allowedAuthTypes, t]
    );

    const readFile = (event) => {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (e) => {
            setSshKey(e.target.result);
        };
        reader.readAsText(file);
    };

    // Same conditions validateFields() enforces, as a value: the button is
    // disabled instead of the click producing a toast (UI-DIRECT-CONNECT-GO,
    // state disabled).
    const canConnect = (authType === "password-only" || Boolean(username))
        && ((authType !== "password" && authType !== "password-only" && authType !== "both") || Boolean(password))
        && ((authType !== "ssh" && authType !== "both") || Boolean(sshKey));

    const validateFields = () => {
        if (authType !== "password-only" && !username) {
            sendToast("Error", t("servers.messages.usernameRequired") || "Username is required");
            return false;
        }

        if ((authType === "password" || authType === "password-only" || authType === "both") && !password) {
            sendToast("Error", t("servers.messages.passwordRequired") || "Password is required");
            return false;
        }

        if ((authType === "ssh" || authType === "both") && !sshKey) {
            sendToast("Error", t("servers.messages.sshKeyRequired") || "SSH key is required");
            return false;
        }

        return true;
    };

    const handleConnect = useCallback(() => {
        if (!validateFields()) return;

        const directIdentity = {
            username: authType === "password-only" ? undefined : username,
            type: authType,
            ...(authType === "password" || authType === "password-only"
                ? { password }
                : authType === "both"
                ? { password, sshKey, passphrase: passphrase || undefined }
                : { sshKey, passphrase: passphrase || undefined }
            ),
        };

        setConnecting(true);
        setAuthError(null);
        // onConnect reports back: true connected, false rejected, undefined the
        // attempt was handed to another dialog. Only a hard false keeps us open
        // -- otherwise the loading state would never be visible at all, because
        // closing in the same handler unmounts the dialog in the same commit.
        Promise.resolve(onConnect(directIdentity))
            .then((result) => {
                if (result?.error) {
                    setConnecting(false);
                    setAuthError(result.error);
                    return;
                }
                onClose();
            })
            .catch((error) => {
                setConnecting(false);
                setAuthError(error?.message || t("servers.unknownError"));
            });
    }, [username, authType, password, sshKey, passphrase, onConnect, onClose, t]);

    useEffect(() => {
        if (!open) return;

        setUsername("");
        setAuthType(defaultAuthType);
        setPassword("");
        setSshKey(null);
        setPassphrase("");
        setConnecting(false);
        setAuthError(null);
    }, [open, defaultAuthType]);

    useEffect(() => {
        if (!open) return;

        const submitOnEnter = (event) => {
            if (event.key === "Enter") {
                handleConnect();
            }
        };

        document.addEventListener("keydown", submitOnEnter);

        return () => {
            document.removeEventListener("keydown", submitOnEnter);
        };
    }, [open, handleConnect]);

    const showUsername = authType !== "password-only";

    return (
        <DialogProvider open={open} onClose={onClose}>
            <div className="direct-connect-dialog">
                <div className="direct-connect-header">
                    <h2>{t("servers.contextMenu.quickConnect")}</h2>
                </div>

                <div className="direct-connect-content">
                    <div className="identity-section" data-ui-id="UI-DIRECT-CONNECT-AUTH">
                        {authError && <p className="direct-connect-error" role="alert">{authError}</p>}
                        <div className={`name-row ${!showUsername ? 'single-column' : ''}`}>
                            {showUsername && (
                                <div className="form-group">
                                    <label htmlFor="direct-connect-username">{t("servers.dialog.fields.username")}</label>
                                    <Input
                                        id="direct-connect-username"
                                        name="direct-connect-username"
                                        icon={mdiAccountCircleOutline}
                                        type="text"
                                        placeholder={t("servers.dialog.placeholders.username")}
                                        autoComplete="off"
                                        value={username}
                                        setValue={setUsername}
                                    />
                                </div>
                            )}

                            <div className="form-group">
                                <label>{t("servers.dialog.identities.authentication")}</label>
                                <SelectBox
                                    options={authOptions}
                                    selected={authType}
                                    setSelected={setAuthType}
                                />
                            </div>
                        </div>

                        {(authType === "password" || authType === "password-only" || authType === "both") && (
                            <div className="form-group">
                                <label htmlFor="direct-connect-password">{t("servers.dialog.fields.password")}</label>
                                {/* Chrome/Firefox ignore autoComplete="off" on password fields and fill
                                    the saved Outpost login instead; "new-password" is the value they honor. */}
                                <Input
                                    id="direct-connect-password"
                                    name="direct-connect-password"
                                    icon={mdiLockOutline}
                                    type="password"
                                    placeholder={t("servers.dialog.placeholders.password")}
                                    autoComplete="new-password"
                                    value={password}
                                    setValue={setPassword}
                                />
                            </div>
                        )}

                        {(authType === "ssh" || authType === "both") && (
                            <>
                                <div className="form-group">
                                    <label htmlFor="direct-connect-keyfile">{t("servers.dialog.identities.sshPrivateKey")}</label>
                                    <Input
                                        id="direct-connect-keyfile"
                                        icon={mdiFileUploadOutline}
                                        type="file"
                                        autoComplete="off"
                                        onChange={readFile}
                                    />
                                </div>

                                <div className="form-group">
                                    <label htmlFor="direct-connect-passphrase">{t("servers.dialog.identities.passphrase")}</label>
                                    {/* Same reasoning as the password field above: "off" is ignored on
                                        password-type inputs by modern browsers. */}
                                    <Input
                                        id="direct-connect-passphrase"
                                        name="direct-connect-passphrase"
                                        icon={mdiLockOutline}
                                        type="password"
                                        placeholder={t("servers.dialog.identities.passphrase")}
                                        autoComplete="new-password"
                                        value={passphrase}
                                        setValue={setPassphrase}
                                    />
                                </div>
                            </>
                        )}
                    </div>
                </div>

                <Button
                    className="direct-connect-button"
                    dataUiId="UI-DIRECT-CONNECT-GO"
                    onClick={handleConnect}
                    disabled={!canConnect || connecting}
                    text={connecting ? t("servers.dialog.connecting") : t("servers.contextMenu.connect")}
                />
            </div>
        </DialogProvider>
    );
};

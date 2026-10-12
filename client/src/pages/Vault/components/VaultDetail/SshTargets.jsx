import { useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe as IconGlobe, Server as IconServer } from "lucide-react";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { deleteRequest } from "@/common/utils/RequestUtil.js";
import { keyAlgorithmLabel, shortFingerprint } from "@/common/utils/sshHostKey.js";
import { sshServers, sshTargetRows } from "../../vaultTypes.js";

const raw = { interpolation: { escapeValue: false } };

export const SshTargets = ({ item, canForget, onForgotten }) => {
    const { t } = useTranslation();
    const { servers } = useContext(ServerContext);
    const [confirming, setConfirming] = useState(null);
    const [failed, setFailed] = useState(false);
    const rows = sshTargetRows(item, sshServers(servers || []));
    const hostKeys = item.hostKeys || [];

    const forget = async (row) => {
        setConfirming(null);
        setFailed(false);
        try {
            await deleteRequest(`vault/items/${item.id}/host-keys/${encodeURIComponent(row.ref)}`);
        } catch (err) {
            if (err?.code !== 404) {
                setFailed(true);
                return;
            }
        }
        onForgotten();
    };

    const confirmedText = (key) => t(key.confirmedBy ? "vault.detail.ssh.confirmed" : "vault.detail.ssh.confirmedAnonymous", {
        date: new Date(key.confirmedAt).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" }),
        name: key.confirmedBy?.name, ...raw,
    });

    return (
        <div className="vault-detail-section">
            <h4>{t("vault.detail.ssh.title")}</h4>
            {rows.length === 0 ? (
                <p className="vault-detail-hint" data-ui-id="UI-VAULT-DETAIL-SSH-TARGETS">{t("vault.detail.ssh.empty")}</p>
            ) : (
                <div data-ui-id="UI-VAULT-DETAIL-SSH-TARGETS">
                    <ul className="vault-ssh-targets">
                        {rows.map((row) => {
                            const key = hostKeys.find((entry) => entry.target === row.ref);
                            return (
                                <li key={row.ref} className={confirming?.ref === row.ref ? "is-selected" : undefined}>
                                    <Icon icon={row.kind === "server" ? IconServer : IconGlobe} />
                                    <span className="vault-ssh-target-name">
                                        <span>{row.name}</span>
                                        {row.address && <span className="vault-detail-mono vault-ssh-target-address">{row.address}</span>}
                                    </span>
                                    {key ? (
                                        <>
                                            <span className="vault-ssh-target-key">
                                                <span className="vault-detail-mono" title={`${key.algorithm} ${key.fingerprint}`}>
                                                    {keyAlgorithmLabel(key.algorithm)} {shortFingerprint(key.fingerprint)}
                                                </span>
                                                {" · "}{confirmedText(key)}
                                            </span>
                                            {canForget && (
                                                <Button type="secondary" buttonType="button" text={t("vault.detail.ssh.forget")}
                                                        onClick={() => { setFailed(false); setConfirming(row); }} />
                                            )}
                                        </>
                                    ) : (
                                        <span className="vault-detail-hint">{t("vault.detail.ssh.never")}</span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    {confirming && (
                        <div className="vault-ssh-confirm" role="alertdialog" aria-label={t("vault.detail.ssh.forget")}>
                            <p>{t("vault.detail.ssh.forgetConfirm", { name: confirming.name, ...raw })}</p>
                            <div className="vault-ssh-confirm-actions">
                                <Button type="secondary" buttonType="button" text={t("common.actions.cancel")}
                                        onClick={() => setConfirming(null)} />
                                <Button type="danger" buttonType="button" text={t("vault.detail.ssh.forget")}
                                        onClick={() => forget(confirming)} />
                            </div>
                        </div>
                    )}
                    {failed && <p className="vault-ssh-error" role="alert">{t("vault.detail.ssh.forgetFailed")}</p>}
                </div>
            )}
        </div>
    );
};

import "./styles.sass";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy as IconCopy, KeyRound as IconKeyRound, Link as IconLink, Network as IconNetwork } from "lucide-react";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import Checkbox from "@/common/components/Checkbox";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import IconInput from "@/common/components/IconInput";
import Icon from "@/common/components/Icon";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useVaultAvailable } from "@/common/hooks/useVaultAvailable.js";
import { deleteRequest, getRequest, postRequest } from "@/common/utils/RequestUtil.js";
import { isValidAgentUrl } from "@/common/utils/agentUrl.js";
import { copyToClipboard } from "@/common/utils/clipboard.js";
import { formatTimeAgo } from "@/common/utils/timeAgo.js";

const AGENT_TYPES = ["claude", "codex"];
const raw = { interpolation: { escapeValue: false } };

// The prefix is optional: Task 8 stores a bare address as /32 or /128.
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6_CIDR = /^([0-9a-f:]+)(?:\/(\d{1,3}))?$/i;

export const isValidCidr = (value) => {
    const v4 = IPV4_CIDR.exec(value);
    if (v4) return v4.slice(1, 5).every((octet) => Number(octet) <= 255) && (v4[5] === undefined || Number(v4[5]) <= 32);
    const v6 = IPV6_CIDR.exec(value);
    if (!v6 || (v6[2] !== undefined && Number(v6[2]) > 128)) return false;
    const address = v6[1];
    if ((address.match(/::/g) || []).length > 1) return false;
    const groups = address.split(":").filter(Boolean);
    return groups.length <= 8 && groups.every((group) => group.length <= 4)
        && (address.includes("::") || groups.length === 8);
};

export const parseCidrs = (text) => text.split(/[\s,]+/).filter(Boolean);

export const AgentAccessDialog = ({ open, entryId, onClose }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const { getServerById } = useContext(ServerContext);
    const { agentUrl: defaultUrl, ipBindingDefault, trustProxyUnsafe, impersonating } = useVaultAvailable();
    const server = entryId ? getServerById(entryId) : null;
    const serverName = server?.name ?? String(entryId ?? "");
    const address = server?.ip ?? "";

    const [keys, setKeys] = useState(null);
    const [remoteUser, setRemoteUser] = useState(null);
    const [otherAccountConfigured, setOtherAccountConfigured] = useState(false);
    const [agents, setAgents] = useState({ claude: true, codex: true });
    const [ipBindingChoice, setIpBinding] = useState(null);
    const [urlText, setUrlText] = useState(null);
    const [cidrText, setCidrText] = useState("");
    const [cidrInvalid, setCidrInvalid] = useState(false);
    const [settingUp, setSettingUp] = useState(false);
    const [results, setResults] = useState([]);
    const [adoptOffer, setAdoptOffer] = useState(null);
    const [adoptSeenIp, setAdoptSeenIp] = useState(false);
    const [probeFailed, setProbeFailed] = useState(false);
    const [revokeTarget, setRevokeTarget] = useState(null);
    const [revokeErrorId, setRevokeErrorId] = useState(null);
    const [revokeOutcome, setRevokeOutcome] = useState(null);
    const setupInFlight = useRef(false);
    const revoking = useRef(false);

    const agentLabel = (type) => t(`vault.agents.${type}`);

    const loadKeys = useCallback(async () => {
        try {
            const data = await getRequest(`vault/agent-keys?entryId=${entryId}`);
            setKeys((data.keys || []).filter((key) => !key.pending));
            setRemoteUser(data.remoteUser ?? null);
            setOtherAccountConfigured(data.otherAccountConfigured === true);
        } catch (err) {
            setKeys([]);
            sendToast(t("common.error"), err?.message || t("common.error"));
        }
    }, [entryId, sendToast, t]);

    useEffect(() => {
        if (open && entryId) loadKeys();
    }, [open, entryId, loadKeys]);

    const discardPending = (list) => Promise.all(list
        .filter((result) => result.id != null && !result.confirmed)
        .map((result) => deleteRequest(`vault/agent-keys/${result.id}`).catch(() => {})));

    // Keys come newest first: the address of the last setup on this server wins over the default.
    const agentUrl = (urlText ?? (keys?.find((key) => key.agentUrl)?.agentUrl || defaultUrl || "")).trim();
    const urlInvalid = !isValidAgentUrl(agentUrl);
    const ipBinding = ipBindingChoice ?? ipBindingDefault !== false;

    const fieldsDisabled = settingUp || impersonating;
    const setupDisabled = fieldsDisabled || !agentUrl || urlInvalid || !AGENT_TYPES.some((type) => agents[type]);

    const setup = async () => {
        if (setupDisabled || setupInFlight.current) return;
        const allowedCidrs = parseCidrs(cidrText);
        if (!allowedCidrs.every(isValidCidr)) {
            setCidrInvalid(true);
            return;
        }
        setCidrInvalid(false);
        setupInFlight.current = true;
        setSettingUp(true);
        try {
            await discardPending(results);
            setResults([]);
            setProbeFailed(false);
            const data = await postRequest("vault/agent-keys", {
                entryId,
                agentTypes: AGENT_TYPES.filter((type) => agents[type]),
                agentUrl,
                ipBinding,
                allowedCidrs,
            });
            const next = data.results.map((result) => ({ ...result, confirmed: result.status === "configured" }));
            const mismatch = ipBinding ? next.find((result) => result.probe?.matches === false) : null;
            setResults(next);
            setAdoptOffer(mismatch ? mismatch.probe.seenIp : null);
            setAdoptSeenIp(false);
            setProbeFailed(ipBinding && next.some((result) => result.probe === null));
            loadKeys();
        } catch (err) {
            sendToast(t("common.error"), err?.message || t("common.error"));
            loadKeys();
        } finally {
            setupInFlight.current = false;
            setSettingUp(false);
        }
    };

    const confirmBody = (result, adopted) => (adopted && result.probe?.matches === false ? { addSeenIp: true } : {});

    const adopt = async () => {
        const offer = adoptOffer;
        setAdoptOffer(null);
        setAdoptSeenIp(true);
        try {
            await Promise.all(results
                .filter((result) => result.confirmed && result.probe?.matches === false)
                .map((result) => postRequest(`vault/agent-keys/${result.id}/confirm`, confirmBody(result, true))));
            loadKeys();
        } catch (err) {
            setAdoptOffer(offer);
            setAdoptSeenIp(false);
            sendToast(t("common.error"), err?.message || t("common.error"));
        }
    };

    const copyCommand = async (result) => {
        if (!(await copyToClipboard(result.command))) {
            sendToast(t("common.error"), t("settings.account.apiKeys.copyError"));
            return;
        }
        if (result.confirmed) return;
        try {
            await postRequest(`vault/agent-keys/${result.id}/confirm`, confirmBody(result, adoptSeenIp));
            setResults((prev) => prev.map((entry) => (entry.id === result.id ? { ...entry, confirmed: true } : entry)));
            loadKeys();
        } catch (err) {
            if (err?.code === 404 || err?.code === 410) {
                setResults((prev) => prev.filter((entry) => entry.id !== result.id));
                loadKeys();
            }
            sendToast(t("common.error"), err?.message || t("common.error"));
        }
    };

    const revoke = async (key) => {
        if (revoking.current) return;
        revoking.current = true;
        setRevokeTarget(null);
        setRevokeOutcome(null);
        try {
            const data = await deleteRequest(`vault/agent-keys/${key.id}`);
            setRevokeErrorId(null);
            if (data.registration === "foreign" || data.registration === "unknown") {
                setRevokeOutcome({ registration: data.registration, commands: data.commands ?? null });
            }
            loadKeys();
        } catch (err) {
            if (err?.code === 404) loadKeys();
            else setRevokeErrorId(key.id);
        } finally {
            revoking.current = false;
        }
    };

    const copyRevokeCommands = async () => {
        if (!(await copyToClipboard(revokeOutcome.commands))) {
            sendToast(t("common.error"), t("settings.account.apiKeys.copyError"));
        }
    };

    const handleClose = () => {
        discardPending(results);
        setResults([]);
        setAdoptOffer(null);
        setAdoptSeenIp(false);
        setProbeFailed(false);
        setKeys(null);
        setCidrText("");
        setCidrInvalid(false);
        setUrlText(null);
        setIpBinding(null);
        setRevokeTarget(null);
        setRevokeErrorId(null);
        setRevokeOutcome(null);
        onClose();
    };

    const onKeyDown = (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            setup();
        }
    };

    const keyMeta = (key) => [
        t("servers.agentAccess.keys.created", {
            date: new Date(key.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" }), ...raw,
        }),
        key.lastUsedAt
            ? t("servers.agentAccess.keys.lastUsed", { time: formatTimeAgo(key.lastUsedAt, t), ...raw })
            : t("settings.account.apiKeys.neverUsed"),
        key.ipBinding
            ? t("servers.agentAccess.keys.boundTo", { address: [address, ...key.allowedCidrs].filter(Boolean).join(", "), ...raw })
            : t("servers.agentAccess.keys.anywhere"),
    ].join(" · ");

    const resultText = (result) => {
        if (result.status === "configured") {
            return t(result.agentType === "codex" ? "servers.agentAccess.result.successCodex" : "servers.agentAccess.result.success",
                { user: result.remoteUser, ...raw });
        }
        return result.reason === "cli_missing"
            ? t("servers.agentAccess.result.error", { cli: result.agentType, ...raw })
            : t("servers.agentAccess.result.manual");
    };

    return (
        <DialogProvider open={open} onClose={handleClose} disableClosing={settingUp}>
            <div className="agent-access-dialog" data-ui-id="UI-AGENT-ACCESS" onKeyDown={onKeyDown}>
                <h2>{t("servers.agentAccess.title", { name: serverName, ...raw })}</h2>

                <section className="agent-access-keys" data-ui-id="UI-AGENT-ACCESS-KEYS" aria-busy={keys === null || undefined}>
                    <h3>{t("servers.agentAccess.keys.title")}</h3>
                    {keys === null ? (
                        <div className="agent-row is-loading">
                            <Icon icon={IconKeyRound} />
                            <span className="skeleton" />
                        </div>
                    ) : keys.length === 0 ? (
                        <p className="agent-access-empty">{t("servers.agentAccess.keys.empty")}</p>
                    ) : keys.map((key) => (
                        <div key={key.id}>
                            <div className="agent-row">
                                <Icon icon={IconKeyRound} />
                                <div className="agent-row-main">
                                    <span>{agentLabel(key.agentType)}</span>
                                    <span className="agent-row-meta">{keyMeta(key)}</span>
                                </div>
                                {!impersonating && (
                                    <Button type="secondary" buttonType="button" text={t("servers.agentAccess.keys.revoke")}
                                            onClick={() => setRevokeTarget(key)} />
                                )}
                            </div>
                            {revokeTarget?.id === key.id && (
                                <div className="agent-access-confirm" role="alertdialog" aria-label={t("servers.agentAccess.keys.revoke")}>
                                    <p>{t("servers.agentAccess.keys.revokeConfirm", { agent: agentLabel(key.agentType), server: serverName, ...raw })}</p>
                                    <div className="agent-access-actions">
                                        <Button type="secondary" buttonType="button" text={t("common.actions.cancel")}
                                                onClick={() => setRevokeTarget(null)} />
                                        <Button type="primary" buttonType="button" text={t("servers.agentAccess.keys.revoke")}
                                                onClick={() => revoke(key)} />
                                    </div>
                                </div>
                            )}
                            {revokeErrorId === key.id && (
                                <p className="agent-access-error" role="alert">{t("servers.agentAccess.keys.revokeError")}</p>
                            )}
                        </div>
                    ))}
                    {revokeOutcome && (
                        <div className="agent-access-revoked" role="status">
                            <p className="agent-access-notice">
                                {revokeOutcome.registration === "foreign"
                                    ? t("servers.agentAccess.keys.revokedForeign", { server: serverName, ...raw })
                                    : t("servers.agentAccess.keys.revokedUnknown")}
                            </p>
                            {revokeOutcome.commands && (
                                <div className="agent-result-command">
                                    <pre>{revokeOutcome.commands}</pre>
                                    <Button type="secondary" buttonType="button" icon={IconCopy}
                                            text={t("servers.agentAccess.result.copy")} onClick={copyRevokeCommands} />
                                </div>
                            )}
                        </div>
                    )}
                </section>

                <form className="agent-access-setup" data-ui-id="UI-AGENT-ACCESS-SETUP" aria-busy={settingUp || undefined}
                      onSubmit={(event) => event.preventDefault()}>
                    {otherAccountConfigured && remoteUser && (
                        <div className="agent-access-warning agent-access-foreign" role="status">
                            <p>{t("servers.agentAccess.setup.foreignAccount", { user: remoteUser, server: serverName, ...raw })}</p>
                        </div>
                    )}
                    <div className="agent-access-checks">
                        {AGENT_TYPES.map((type) => (
                            <div className="agent-access-check" key={type}>
                                <Checkbox id={`agent-access-${type}`} checked={agents[type]} disabled={fieldsDisabled}
                                          onChange={(checked) => setAgents((prev) => ({ ...prev, [type]: checked }))} />
                                <label htmlFor={`agent-access-${type}`}>{agentLabel(type)}</label>
                            </div>
                        ))}
                    </div>
                    <div className={`agent-access-cidr-field${cidrInvalid ? " is-error" : ""}`}>
                        <label htmlFor="agent-access-cidrs">{t("servers.agentAccess.setup.cidrLabel")}</label>
                        <IconInput id="agent-access-cidrs" icon={IconNetwork} value={cidrText} disabled={fieldsDisabled}
                                   setValue={(value) => { setCidrText(value); setCidrInvalid(false); }} />
                        {cidrInvalid && (
                            <span className="agent-access-help is-error" role="alert">{t("servers.agentAccess.setup.cidrInvalid")}</span>
                        )}
                    </div>
                    <div className={`agent-access-url-field${urlInvalid ? " is-error" : ""}`} data-ui-id="UI-AGENT-ACCESS-URL">
                        <label htmlFor="agent-access-url">{t("servers.agentAccess.setup.urlLabel")}</label>
                        <IconInput id="agent-access-url" icon={IconLink} value={agentUrl} disabled={fieldsDisabled}
                                   setValue={setUrlText} />
                        {urlInvalid ? (
                            <span className="agent-access-help is-error" role="alert">{t("servers.agentAccess.setup.urlInvalid")}</span>
                        ) : !agentUrl && (
                            <span className="agent-access-help agent-access-url-missing">{t("servers.agentAccess.setup.urlMissing")}</span>
                        )}
                    </div>
                    <div className="agent-access-submit">
                        <Button type="primary" buttonType="button" onClick={setup} disabled={setupDisabled} loading={settingUp} kbd="Ctrl+Enter"
                                text={settingUp ? t("servers.agentAccess.setup.loading") : t("servers.agentAccess.setup.submit")} />
                    </div>
                </form>

                <div className="agent-access-ipbind" data-ui-id="UI-AGENT-ACCESS-IPBIND">
                    <div className="agent-access-ipbind-row">
                        <div className="agent-access-ipbind-label">
                            <label htmlFor="agent-access-ipbind">{t("servers.agentAccess.ipBind.label")}</label>
                            <span className="agent-access-help">
                                {ipBinding
                                    ? <>{t("servers.agentAccess.ipBind.on")} · <span className="mono">{address}</span></>
                                    : t("servers.agentAccess.ipBind.off")}
                            </span>
                        </div>
                        <ToggleSwitch id="agent-access-ipbind" checked={ipBinding} onChange={setIpBinding} disabled={fieldsDisabled} />
                    </div>
                    {adoptOffer && (
                        <div className="agent-access-confirm" role="status">
                            <p>{t("servers.agentAccess.ipBind.seenOther", { seen: adoptOffer, expected: address, ...raw })}</p>
                            <div className="agent-access-actions">
                                <Button type="secondary" buttonType="button" text={t("servers.agentAccess.ipBind.decline")}
                                        onClick={() => setAdoptOffer(null)} />
                                <Button type="primary" buttonType="button" text={t("servers.agentAccess.ipBind.adopt")}
                                        onClick={adopt} />
                            </div>
                        </div>
                    )}
                    {probeFailed && (
                        <p className="agent-access-notice" role="status">{t("servers.agentAccess.ipBind.probeFailed")}</p>
                    )}
                    {trustProxyUnsafe && (
                        <div className="agent-access-warning" role="alert">
                            <p>{t("servers.agentAccess.ipBind.trustProxy")}</p>
                        </div>
                    )}
                </div>

                <section className="agent-access-result" data-ui-id="UI-AGENT-ACCESS-RESULT">
                    {results.length === 0 ? (
                        <p className="agent-access-empty">{t("servers.agentAccess.result.empty")}</p>
                    ) : results.map((result) => (
                        <div key={result.id ?? result.agentType} className={`agent-result ${result.status === "configured" ? "is-ok" : "is-fail"}`}>
                            <div className="agent-result-head">
                                <span>{agentLabel(result.agentType)}</span>
                                <span className="agent-result-status">
                                    {t(result.status === "configured" ? "servers.agentAccess.result.configured" : "servers.agentAccess.result.failed")}
                                </span>
                            </div>
                            <p className={`agent-access-help${result.status === "configured" ? "" : " is-error"}`}>{resultText(result)}</p>
                            {result.replacedRegistration && (
                                <p className="agent-access-notice">{t("servers.agentAccess.result.replaced")}</p>
                            )}
                            {result.status !== "configured" && result.command && (
                                <>
                                    <div className="agent-result-command">
                                        <pre>{result.command}</pre>
                                        <Button type="secondary" buttonType="button" icon={IconCopy}
                                                text={t("servers.agentAccess.result.copy")} onClick={() => copyCommand(result)} />
                                    </div>
                                    {!result.confirmed && (
                                        <p className="agent-access-notice">{t("servers.agentAccess.result.keyNotice")}</p>
                                    )}
                                </>
                            )}
                        </div>
                    ))}
                </section>
            </div>
        </DialogProvider>
    );
};

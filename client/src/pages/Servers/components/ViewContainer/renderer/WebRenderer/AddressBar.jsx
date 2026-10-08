import { useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import { ArrowLeft as IconArrowLeft, ArrowRight as IconArrowRight, RotateCw as IconRotateCw, X as IconX, Pause as IconPause, Play as IconPlay } from "lucide-react";

const withScheme = (value) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);

const AddressBar = ({ page, agent, connected, onNavigate, onHistory, onPause, onClose }) => {
    const { t } = useTranslation();
    const [draft, setDraft] = useState("");
    const [editing, setEditing] = useState(false);

    const submit = (e) => {
        e.preventDefault();
        const url = draft.trim();
        setEditing(false);
        e.currentTarget.querySelector("input")?.blur();
        if (url) onNavigate(withScheme(url));
    };

    const agentText = agent.active ? t("servers.webRenderer.agentActive", { tool: agent.tool })
        : agent.paused ? t("servers.webRenderer.paused") : null;

    return (
        <form className="web-address-bar" onSubmit={submit}>
            <button type="button" aria-label={t("servers.webRenderer.back")} disabled={!connected || !page.canGoBack} onClick={() => onHistory("back")}>
                <Icon icon={IconArrowLeft} />
            </button>
            <button type="button" aria-label={t("servers.webRenderer.forward")} disabled={!connected || !page.canGoForward} onClick={() => onHistory("forward")}>
                <Icon icon={IconArrowRight} />
            </button>
            <button type="button" aria-label={t("servers.webRenderer.reload")} disabled={!connected} onClick={() => onHistory("reload")}>
                <Icon icon={IconRotateCw} spin={page.loading} />
            </button>
            <input aria-label={t("servers.webRenderer.address")} spellCheck={false} value={editing ? draft : page.url}
                   onFocus={() => { setDraft(page.url); setEditing(true); }}
                   onBlur={() => setEditing(false)}
                   onChange={(e) => setDraft(e.target.value)} />
            <span className={`web-agent${agent.active ? " is-active" : ""}${agent.paused ? " is-paused" : ""}`}
                  title={agentText ?? t("servers.webRenderer.agentIdle")}>
                <span className="web-agent-dot" aria-hidden="true" />
                {agentText && <span>{agentText}</span>}
            </span>
            <button type="button" aria-pressed={agent.paused} disabled={!connected} onClick={() => onPause(!agent.paused)}
                    aria-label={agent.paused ? t("servers.webRenderer.resume") : t("servers.webRenderer.pause")}>
                <Icon icon={agent.paused ? IconPlay : IconPause} />
            </button>
            <button type="button" aria-label={t("servers.webRenderer.close")} disabled={!connected} onClick={onClose}>
                <Icon icon={IconX} />
            </button>
        </form>
    );
};

export default AddressBar;

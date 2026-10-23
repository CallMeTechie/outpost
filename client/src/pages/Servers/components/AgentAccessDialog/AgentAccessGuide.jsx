import { useContext, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
    ArrowRight as IconArrowRight, BookOpen as IconBookOpen, Check as IconCheck, ChevronRight as IconChevronRight,
    Copy as IconCopy, GitBranch as IconGitBranch, Globe as IconGlobe, Link as IconLink, Network as IconNetwork,
    Plug as IconPlug, Server as IconServer, ShieldCheck as IconShieldCheck, Terminal as IconTerminal,
    Undo2 as IconUndo, X as IconX,
} from "lucide-react";
import { DialogContext, DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import { copyToClipboard } from "@/common/utils/clipboard.js";

const G = "servers.agentAccess.guide";
const SECTIONS = ["how", "needs", "github", "gitlab", "tips"];
const markup = { mono: <code />, b: <strong /> };
const GITHUB_PATH = ["Settings", "Developer settings", "Personal access tokens", "Fine-grained tokens", "Generate new token"];
const CLONE = "git clone https://github.com/owner/repo.git";
const SET_URL = "git remote set-url origin https://github.com/owner/repo.git";

const CopyButton = ({ value }) => {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        if (!(await copyToClipboard(value))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };
    const label = t(copied ? `${G}.copied` : `${G}.copy`);
    return (
        <button type="button" className="guide-copy" onClick={copy} aria-label={label} title={label}>
            <Icon icon={copied ? IconCheck : IconCopy} />
        </button>
    );
};

const Command = ({ value }) => (
    <div className="guide-cmd"><code>{value}</code><CopyButton value={value} /></div>
);

const Fields = ({ rows }) => (
    <dl className="guide-fields">
        {rows.map(({ label, value, hint, copy }) => (
            <div className="guide-field" key={label}>
                <dt>{label}</dt>
                <dd>
                    <span>{value}{hint && <small>{hint}</small>}</span>
                    {copy && <CopyButton value={copy} />}
                </dd>
            </div>
        ))}
    </dl>
);

const Step = ({ n, title, children }) => (
    <li className="guide-step">
        <span className="guide-step-n" aria-hidden="true">{n}</span>
        <div><strong>{title}</strong>{children}</div>
    </li>
);

const Phase = ({ icon, title, children }) => (
    <div className="guide-phase">
        <div className="guide-label"><Icon icon={icon} />{title}</div>
        <ol className="guide-steps">{children}</ol>
    </div>
);

const Card = ({ icon, title, children }) => (
    <div className="guide-card">
        <div className="guide-card-head"><Icon icon={icon} />{title}</div>
        {children}
    </div>
);

const T = ({ k, values }) => <Trans i18nKey={k} values={values} components={markup} tOptions={{ interpolation: { escapeValue: false } }} />;

const How = () => {
    const { t } = useTranslation();
    const node = (icon, name, hub = false) => (
        <div className={`guide-node${hub ? " is-hub" : ""}`}>
            <strong><Icon icon={icon} />{t(`${G}.how.${name}`)}</strong>
            <span>{t(`${G}.how.${name}Text`)}</span>
        </div>
    );
    const agent = (icon, name, labelKey) => (
        <Card icon={icon} title={t(labelKey)}>
            <p><T k={`${G}.how.${name}`} /></p>
            <p className="guide-after"><T k={`${G}.how.${name}After`} /></p>
        </Card>
    );
    return (
        <>
            <div className="guide-flow">
                {node(IconTerminal, "agent")}
                <Icon icon={IconArrowRight} />
                {node(IconShieldCheck, "outpost", true)}
                <Icon icon={IconArrowRight} />
                {node(IconGlobe, "service")}
            </div>
            <div className="guide-label">{t(`${G}.how.setUpLabel`)}</div>
            <div className="guide-cards">
                {agent(IconPlug, "claude", "vault.agents.claude")}
                {agent(IconPlug, "codex", "vault.agents.codex")}
                {agent(IconGitBranch, "git", "vault.agents.git")}
            </div>
            <div className="guide-cards">
                <Card icon={IconTerminal} title={t(`${G}.how.ssh`)}>
                    <p>{t(`${G}.how.sshText`)}</p>
                </Card>
            </div>
        </>
    );
};

const Needs = () => {
    const { t } = useTranslation();
    const check = (icon, name, extra = null) => (
        <div className="guide-check">
            <span className="guide-check-icon"><Icon icon={icon} /></span>
            <div>
                <strong>{t(`${G}.needs.${name}`)}</strong>
                <p><T k={`${G}.needs.${name}Text`} /></p>
                {extra}
            </div>
        </div>
    );
    const example = (ok, url, note) => (
        <li className={`guide-example ${ok ? "is-ok" : "is-wrong"}`}>
            <Icon icon={ok ? IconCheck : IconX} /><code>{url}</code><small>{note}</small>
        </li>
    );
    return (
        <div className="guide-checks">
            {check(IconServer, "ssh")}
            {check(IconLink, "address", (
                <ul className="guide-examples">
                    {example(true, "http://192.168.1.10:6989", t(`${G}.needs.lan`))}
                    {example(true, "https://outpost.example.net", t(`${G}.needs.proxy`))}
                    {example(false, "https://192.168.1.10:6989", t(`${G}.needs.wrong`))}
                </ul>
            ))}
            {check(IconTerminal, "programs")}
        </div>
    );
};

const GitHub = () => {
    const { t } = useTranslation();
    const h = `${G}.github`;
    return (
        <>
            <Phase icon={IconGlobe} title={t(`${h}.onGithub`)}>
                <Step n={1} title={t(`${h}.token`)}>
                    <div className="guide-path">
                        {GITHUB_PATH.map((part, index) => (
                            <span key={part}>{index > 0 && <Icon icon={IconChevronRight} />}<span>{part}</span></span>
                        ))}
                    </div>
                </Step>
                <Step n={2} title={t(`${h}.scope`)}>
                    <Fields rows={[
                        { label: "Repository access", value: "Only select repositories" },
                        { label: "Contents", value: "Read and write", hint: t(`${h}.contentsHint`) },
                        { label: "Issues, Pull requests", value: t(`${h}.issuesValue`) },
                        { label: "Expiration", value: t(`${h}.expirationValue`) },
                    ]} />
                </Step>
                <Step n={3} title={t(`${h}.copyToken`)}><p>{t(`${h}.copyTokenText`)}</p></Step>
            </Phase>
            <Phase icon={IconShieldCheck} title={t(`${h}.inOutpost`)}>
                <Step n={4} title={t(`${h}.entry`, { vault: t("vault.page.title"), newEntry: t("vault.page.addItem") })}>
                    <Fields rows={[
                        { label: t("vault.dialog.type"), value: t("vault.types.apiKey") },
                        { label: t("vault.fields.name"), value: <code>github</code> },
                        { label: t("vault.fields.hosts"), value: <code>api.github.com, github.com</code>, copy: "api.github.com, github.com" },
                        { label: t("vault.secretFields.token"), value: t(`${h}.tokenValue`) },
                    ]} />
                </Step>
                <Step n={5} title={t(`${h}.git`, { useForGit: t("vault.dialog.usage.git") })}>
                    <Fields rows={[
                        { label: t("vault.dialog.usage.gitUsername"), value: <code>x-access-token</code>, copy: "x-access-token" },
                        { label: t("vault.dialog.usage.readOnly"), value: t(`${h}.readOnlyValue`) },
                    ]} />
                </Step>
                <Step n={6} title={t(`${h}.share`)}>
                    <p>{t(`${h}.shareText`, {
                        scope: t("vault.detail.scope"), allServers: t("vault.bindings.allServers"),
                        approval: t("vault.policy.required"), create: t("vault.dialog.create"),
                    })}</p>
                </Step>
                <Step n={7} title={t(`${h}.setup`, { setup: t("servers.agentAccess.setup.submit") })}>
                    <p>{t(`${h}.setupText`)}</p>
                </Step>
            </Phase>
            <Phase icon={IconTerminal} title={t(`${h}.onServer`)}>
                <Step n={8} title={t(`${h}.try`)}>
                    <Command value={CLONE} />
                    <p>{t(`${h}.tryText`)}</p>
                </Step>
            </Phase>
        </>
    );
};

const GitLab = () => {
    const { t } = useTranslation();
    const l = `${G}.gitlab`;
    return (
        <Fields rows={[
            { label: t("vault.fields.hosts"), value: <><code>gitlab.com</code> {t(`${l}.hostsValue`)}</> },
            { label: t("vault.dialog.usage.gitUsername"), value: <code>oauth2</code>, copy: "oauth2" },
            { label: t("vault.secretFields.token"), value: t(`${l}.tokenValue`) },
            { label: t(`${l}.scopes`), value: <><code>read_repository</code>, <code>write_repository</code></> },
            { label: t(`${l}.api`), value: <T k={`${l}.apiValue`} /> },
        ]} />
    );
};

const Tips = () => {
    const { t } = useTranslation();
    const k = `${G}.tips`;
    return (
        <div className="guide-cards guide-cards--two">
            <Card icon={IconGitBranch} title={t(`${k}.https`)}>
                <p><T k={`${k}.httpsText`} /></p>
                <Command value={SET_URL} />
            </Card>
            <Card icon={IconShieldCheck} title={t(`${k}.approval`)}>
                <p>{t(`${k}.approvalText`, { once: t("vault.approval.actions.once"), session: t("vault.approval.actions.session") })}</p>
                <div className="guide-mini" aria-hidden="true">
                    <span>{t("vault.approval.actions.once")}</span>
                    <span>{t("vault.approval.actions.session")}</span>
                    <span className="guide-badge">{t("vault.approval.write")}</span>
                </div>
            </Card>
            <Card icon={IconNetwork} title={t(`${k}.ipBind`)}>
                <p>{t(`${k}.ipBindText`, { label: t("servers.agentAccess.ipBind.label") })}</p>
            </Card>
            <Card icon={IconUndo} title={t(`${k}.revoke`)}>
                <p>{t(`${k}.revokeText`)}</p>
            </Card>
            <Card icon={IconTerminal} title={t(`${k}.ssh`)}>
                <p><T k={`${k}.sshText`} /></p>
            </Card>
        </div>
    );
};

const PANES = { how: How, needs: Needs, github: GitHub, gitlab: GitLab, tips: Tips };

// Rendered inside the guide's own DialogProvider, so "Done" closes the guide and not the agent-access dialog.
const Footer = ({ index, setIndex }) => {
    const { t } = useTranslation();
    const close = useContext(DialogContext);
    const last = index === SECTIONS.length - 1;
    return (
        <footer className="guide-foot">
            <span className="guide-progress">{t(`${G}.progress`, { current: index + 1, total: SECTIONS.length })}</span>
            {index > 0 && <Button type="secondary" buttonType="button" text={t(`${G}.back`)} onClick={() => setIndex(index - 1)} />}
            <Button type="primary" buttonType="button"
                    text={last ? t(`${G}.done`) : t(`${G}.next`, { section: t(`${G}.${SECTIONS[index + 1]}.nav`) })}
                    onClick={last ? close : () => setIndex(index + 1)} />
        </footer>
    );
};

export const AgentAccessGuide = ({ open, onClose }) => {
    const { t } = useTranslation();
    const [index, setIndex] = useState(0);
    const section = SECTIONS[index];
    const Pane = PANES[section];
    return (
        <DialogProvider open={open} onClose={() => { setIndex(0); onClose(); }}>
            <div className="agent-access-guide" data-ui-id="UI-AGENT-ACCESS-GUIDE">
                <header className="guide-head">
                    <span className="guide-head-icon"><Icon icon={IconBookOpen} /></span>
                    <div>
                        <h2>{t(`${G}.title`)}</h2>
                        <p>{t(`${G}.subtitle`)}</p>
                    </div>
                </header>
                <div className="guide-body">
                    <nav className="guide-nav" aria-label={t(`${G}.sectionsLabel`)}>
                        {SECTIONS.map((name, position) => (
                            <button type="button" key={name} aria-current={position === index ? "step" : undefined}
                                    onClick={() => setIndex(position)}>
                                <span className="guide-nav-n" aria-hidden="true">{position + 1}</span>
                                <span className="guide-nav-label">{t(`${G}.${name}.nav`)}</span>
                            </button>
                        ))}
                    </nav>
                    <section className="guide-pane" key={section} aria-labelledby="agent-access-guide-heading">
                        <h3 id="agent-access-guide-heading">{t(`${G}.${section}.nav`)}</h3>
                        <p className="guide-lead">{t(`${G}.${section}.lead`)}</p>
                        <Pane />
                    </section>
                </div>
                <Footer index={index} setIndex={setIndex} />
            </div>
        </DialogProvider>
    );
};

import { Trans, useTranslation } from "react-i18next";
import { DialogCancelButton, DialogProvider } from "@/common/components/Dialog";

const GUIDE = "servers.agentAccess.guide";
const markup = { mono: <span className="mono" />, b: <strong /> };

const Items = ({ name, ordered = false }) => {
    const { t } = useTranslation();
    const items = t(`${GUIDE}.${name}`, { returnObjects: true });
    const List = ordered ? "ol" : "ul";
    return (
        <List>
            {(Array.isArray(items) ? items : []).map((_, index) => (
                <li key={index}><Trans i18nKey={`${GUIDE}.${name}.${index}`} components={markup} /></li>
            ))}
        </List>
    );
};

export const AgentAccessGuide = ({ open, onClose }) => {
    const { t } = useTranslation();
    return (
        <DialogProvider open={open} onClose={onClose}>
            <div className="agent-access-guide" data-ui-id="UI-AGENT-ACCESS-GUIDE" role="document">
                <h2>{t(`${GUIDE}.title`)}</h2>
                <p>{t(`${GUIDE}.intro`)}</p>
                <h3>{t(`${GUIDE}.needsTitle`)}</h3>
                <Items name="needs" />
                <h3>{t(`${GUIDE}.agentsTitle`)}</h3>
                <Items name="agents" />
                <h3>{t(`${GUIDE}.githubTitle`)}</h3>
                <Items name="github" ordered />
                <p><Trans i18nKey={`${GUIDE}.gitlab`} components={markup} /></p>
                <h3>{t(`${GUIDE}.notesTitle`)}</h3>
                <Items name="notes" />
                <div className="agent-access-guide-actions">
                    <DialogCancelButton text={t(`${GUIDE}.close`)} />
                </div>
            </div>
        </DialogProvider>
    );
};

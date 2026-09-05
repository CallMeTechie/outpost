import "./styles.sass";
import { useTranslation } from "react-i18next";

// The strip above each pane (docs/design/mockups/ui-servers.html, .pane-head): the pane's
// colour, what it is, and the one or two facts about it that live nowhere else.
//
// It is not a second tab label. The tab says which session; this says what that session
// currently *is* -- a terminal's size and tmux window, a file pane's directory. Both change
// while you work and neither had anywhere to be shown before: the terminal size was known only
// to xterm, and the directory only to the file pane's own breadcrumb.
//
// Present on every pane, not only in a split. The artboard draws it in focus mode and in the
// loading and error states too, and the reason holds there: 80×24 is worth knowing whether or
// not a second pane exists.
const TYPE_KEY = {
    sftp: "servers.tabLabel.type.sftp",
    notes: "servers.tabLabel.type.notes",
    onedrive: "servers.tabLabel.type.onedrive",
};

const typeLabel = (session, t) => {
    if (session?.type && TYPE_KEY[session.type]) return t(TYPE_KEY[session.type]);
    return session?.server?.renderer === "guac"
        ? t("servers.tabLabel.type.remoteDesktop")
        : t("servers.tabLabel.type.terminal");
};

export const PaneHead = ({ session, meta = {}, paneColor }) => {
    const { t } = useTranslation();

    const name = session?.server?.name ?? session?.oneDrive?.displayName ?? "";
    const kind = typeLabel(session, t);
    // A notes pane is called "Notizen" and is of type "Notizen"; saying it twice is noise.
    const showKind = kind && kind !== name;

    // Right-hand facts, in the order the artboard has them: what the session is attached to,
    // then how big it is. Each is left out when it does not apply rather than shown empty --
    // a pane head with "tmux: —" in it says less than one without the field.
    // Only the size. tmux is already in the tab label -- buildTabLabel uses the session name
    // as its discriminator ("nas · main") -- and showing it twice on one screen adds nothing.
    const facts = [
        meta.cols && meta.rows && `${meta.cols}×${meta.rows}`,
    ].filter(Boolean);

    return (
        <div className="pane-head" style={paneColor ? { "--pane-color": paneColor } : undefined}>
            <span className="swatch" aria-hidden="true" />
            <span className="what">
                {name}
                {showKind && <><span className="sep"> · </span>{kind}</>}
            </span>
            {meta.path && <span className="path" title={meta.path}>{meta.path}</span>}
            {facts.length > 0 && (
                <span className="right">
                    {facts.map((fact) => <span key={fact}>{fact}</span>)}
                </span>
            )}
        </div>
    );
};

export default PaneHead;

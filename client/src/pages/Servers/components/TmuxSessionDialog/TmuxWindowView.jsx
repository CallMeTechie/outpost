import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiArrowLeft, mdiViewSplitVertical } from "@mdi/js";

/**
 * A window name may contain any character, including control characters -
 * unlike a session name, which tmux itself restricts. They are not shown as
 * is: a window renamed from outside to a name containing escape sequences
 * must not be able to break the list's layout.
 */
export const displayName = (value) => String(value ?? "").replace(/[\x00-\x1F\x7F]/g, "");

/**
 * The window view of a session. Its own file, because it carries its own
 * interaction state and would otherwise leave the picker with two nearly
 * identical three-state blocks side by side.
 */
const TmuxWindowView = ({ session, entryId, identityId, onBack, onConnect,
                          onResult, onFailure, onLocalRemove, onLocalRename, onLastWindowClosed }) => {
    const { t } = useTranslation();
    const windows = session.windowList || [];

    return (
        <>
            <div className="tmux-crumb">
                <button className="tmux-icon-button" type="button"
                        title={t('servers.tmuxDialog.windowsBack')}
                        aria-label={t('servers.tmuxDialog.windowsBack')}
                        onClick={onBack}>
                    <Icon path={mdiArrowLeft} size={0.7} />
                </button>
                <h3>{t('servers.tmuxDialog.windowsTitle', {
                    name: displayName(session.name),
                    interpolation: { escapeValue: false },
                })}</h3>
            </div>

            {windows.length === 0 ? (
                // Occurs when the session ends between the two tmux commands: the
                // S record is there, the W records are missing. A silently empty
                // list would be the wrong statement here.
                <p className="tmux-status">{t('servers.tmuxDialog.windowsUnreadable')}</p>
            ) : (
                <ul className="tmux-session-list">
                    {windows.map((win) => {
                        const shown = displayName(win.name);
                        return (
                            <li key={win.id} className="tmux-session-row">
                                <button className="tmux-session-item" type="button"
                                        onClick={() => onConnect(win.id)}>
                                    <span className="tmux-session-name">
                                        <span className="tmux-window-index">{win.index}</span>
                                        {shown.length > 0
                                            ? shown
                                            : <em className="tmux-window-unnamed">{t('servers.tmuxDialog.windowUnnamed')}</em>}
                                    </span>
                                    <span className="tmux-session-meta">
                                        {win.panes > 1 && (
                                            <span className="tmux-window-panes"
                                                  title={t('servers.tmuxDialog.windowPanes', { count: win.panes })}>
                                                <Icon path={mdiViewSplitVertical} size={0.55} />{win.panes}
                                            </span>
                                        )}
                                        {win.active && t('servers.tmuxDialog.attachedLabel')}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </>
    );
};

export default TmuxWindowView;

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiArrowLeft, mdiViewSplitVertical, mdiPencil, mdiTrashCan, mdiCheck, mdiClose } from "@mdi/js";
import { postRequest, deleteRequest, patchRequest } from "@/common/utils/RequestUtil.js";
import Button from "@/common/components/Button";
import { sanitizeRemoteText } from "@/common/utils/remoteText.js";

/**
 * A window name may contain any character, including control and bidi
 * characters - unlike a session name, which tmux itself restricts. They are
 * not shown as is: a window renamed from outside to a name containing escape
 * sequences or bidi overrides must not be able to break the list's layout or
 * make the name render as something it is not.
 *
 * Sanitizing is shared with the rest of the app (remoteText.js) rather than
 * repeated here, and unlike the tooltip that also uses it, no length limit is
 * passed - this view has never truncated window names and shows them in full.
 */
export const displayName = (value) => sanitizeRemoteText(value, Infinity);

const WINDOW_NAME_PATTERN = /^[^\x00-\x1F\x7F]{1,64}$/;

/**
 * Lock marker for creating. It must not collide with any other value that
 * busyName can carry: session names cannot contain an @ (CREATE_NAME_PATTERN),
 * and a window id is always @ plus digits - "@create" is therefore
 * unreachable in either namespace.
 */
const CREATE_BUSY = "@create";

/**
 * The window view of a session. Its own file, because it carries its own
 * interaction state and would otherwise leave the picker with two nearly
 * identical three-state blocks side by side.
 */
const TmuxWindowView = ({ session, entryId, identityId, onBack, onConnect,
                          onResult, onFailure, onLocalRemove, onLocalRename, onLastWindowClosed }) => {
    const { t } = useTranslation();
    const windows = session.windowList || [];

    const [busy, setBusy] = useState(null);
    const [renaming, setRenaming] = useState(null);
    const [renameValue, setRenameValue] = useState("");
    const [pendingKill, setPendingKill] = useState(null);   // { id, text, soft }
    const [newName, setNewName] = useState("");

    // The view stays mounted across a session switch when the user opens a
    // different session in the dialog. Half-typed names and open confirmations
    // no longer belong to it at that point.
    useEffect(() => {
        setRenaming(null);
        setPendingKill(null);
        setNewName("");
    }, [session.name, entryId]);

    const query = (param, value) =>
        `?${identityId ? `identityId=${identityId}&` : ""}${param}=${encodeURIComponent(value)}`;

    // Against stale responses after a host switch, the same pattern as in the
    // picker applies:
    const entryIdRef = useRef(entryId);
    useEffect(() => { entryIdRef.current = entryId; }, [entryId]);

    /**
     * Two confirmation rules, the first takes precedence: closing the last
     * window ends the session, that has to be stated clearly. Otherwise it
     * only asks when someone is actually looking at this window - matching
     * the rule for sessions.
     *
     * Whether it is the last one is decided by the length of the displayed
     * list, not the `windows` field: the confirmation should refer to what
     * the user actually sees in front of them.
     */
    const requestKill = (win) => {
        if (windows.length === 1) {
            setPendingKill({
                id: win.id, soft: false,
                text: t('servers.tmuxDialog.windowKillLastConfirm', {
                    name: displayName(session.name),
                    interpolation: { escapeValue: false },
                }),
            });
            return;
        }
        if (win.active && session.attached) {
            setPendingKill({ id: win.id, soft: true, text: t('servers.tmuxDialog.windowKillConfirm') });
            return;
        }
        kill(win);
    };

    const kill = async (win) => {
        if (busy !== null) return;
        const wasLast = windows.length === 1;
        setPendingKill(null);
        setBusy(win.id);

        const requestEntryId = entryId;
        try {
            const result = await deleteRequest(`/entries/${entryId}/tmux/windows${query("window", win.id)}`);
            if (entryIdRef.current !== requestEntryId) return;
            // The refresh may have failed, the action still went through.
            // Update the row locally, otherwise the user clicks a second
            // time and hits nothing.
            const refreshed = onResult(result);
            if (!refreshed) onLocalRemove(win.id);
            // wasLast is about the confirmation text and reflects the list as
            // shown, which can be stale. The session-ended notice needs the
            // truth: only fire it when the fresh listing agrees the session
            // is actually gone, or when there is no fresh listing to check
            // against.
            if (wasLast && (!refreshed || !(result.sessions || []).some((s) => s.name === session.name)))
                onLastWindowClosed(session.name);
        } catch (error) {
            if (entryIdRef.current !== requestEntryId) return;
            onFailure(error);
        } finally {
            setBusy((prev) => (prev === win.id ? null : prev));
        }
    };

    const rename = async (win) => {
        const nextName = renameValue;
        if (busy !== null || !WINDOW_NAME_PATTERN.test(nextName)) return;
        if (nextName === win.name) { setRenaming(null); return; }

        setBusy(win.id);
        const requestEntryId = entryId;
        try {
            const result = await patchRequest(
                `/entries/${entryId}/tmux/windows${query("window", win.id)}`, { name: nextName });
            if (entryIdRef.current !== requestEntryId) return;
            setRenaming(null);
            if (!onResult(result)) onLocalRename(win.id, nextName);
        } catch (error) {
            if (entryIdRef.current !== requestEntryId) return;
            onFailure(error);
        } finally {
            setBusy((prev) => (prev === win.id ? null : prev));
        }
    };

    const create = async () => {
        if (busy !== null) return;
        const wanted = newName;
        if (wanted.length > 0 && !WINDOW_NAME_PATTERN.test(wanted)) return;

        setBusy(CREATE_BUSY);
        const requestEntryId = entryId;
        try {
            // An empty field means "no name": the server then leaves -n out
            // entirely and tmux assigns its default name.
            const body = wanted.length > 0 ? { name: wanted } : {};
            const result = await postRequest(
                `/entries/${entryId}/tmux/windows${query("session", session.name)}`, body);
            if (entryIdRef.current !== requestEntryId) return;
            setNewName("");
            // Unlike kill/rename there is no local follow-up here if the refresh
            // failed: the response carries no id for the new window, so there is
            // no row to append or amend by hand. onResult itself already raises
            // the refreshFailed notice for that case (see applyResult).
            onResult(result);
        } catch (error) {
            if (entryIdRef.current !== requestEntryId) return;
            onFailure(error);
        } finally {
            setBusy((prev) => (prev === CREATE_BUSY ? null : prev));
        }
    };

    return (
        <>
            <div className="tmux-crumb">
                <button className="tmux-icon-button" type="button" disabled={busy !== null}
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
                        const nameOk = WINDOW_NAME_PATTERN.test(renameValue);

                        if (pendingKill && pendingKill.id === win.id) {
                            return (
                                <li key={win.id} className="tmux-session-row">
                                    <div className={pendingKill.soft
                                        ? "tmux-row-confirm tmux-window-confirm is-soft"
                                        : "tmux-row-confirm tmux-window-confirm"}>
                                        <span>{pendingKill.text}</span>
                                        <div className="tmux-session-actions">
                                            <button className="tmux-icon-button tmux-confirm-yes" disabled={busy !== null}
                                                    title={t('servers.tmuxDialog.actions.windowKill')}
                                                    aria-label={t('servers.tmuxDialog.actions.windowKill')}
                                                    onClick={() => kill(win)}>
                                                <Icon path={mdiCheck} size={0.7} />
                                            </button>
                                            <button className="tmux-icon-button" disabled={busy !== null}
                                                    title={t('servers.tmuxDialog.actions.cancelKill')}
                                                    aria-label={t('servers.tmuxDialog.actions.cancelKill')}
                                                    onClick={() => setPendingKill(null)}>
                                                <Icon path={mdiClose} size={0.7} />
                                            </button>
                                        </div>
                                    </div>
                                </li>
                            );
                        }

                        if (renaming === win.id) {
                            return (
                                <li key={win.id} className="tmux-session-row">
                                    <div className="tmux-row-rename">
                                        <input type="text" value={renameValue} maxLength={64} autoFocus
                                               disabled={busy !== null}
                                               onChange={(e) => setRenameValue(e.target.value)}
                                               onKeyDown={(e) => {
                                                   if (e.key === "Enter") rename(win);
                                                   if (e.key === "Escape") {
                                                       // DialogProvider closes the whole dialog on Escape via a
                                                       // listener on document. React delivers the event at the
                                                       // portal container, i.e. before it gets there -
                                                       // stopPropagation() stops it here, so only the field
                                                       // closes and the connection attempt behind it stays open.
                                                       e.stopPropagation();
                                                       setRenaming(null);
                                                   }
                                               }} />
                                        <button className="tmux-icon-button" disabled={busy !== null || !nameOk}
                                                title={t('servers.tmuxDialog.actions.confirmRename')}
                                                aria-label={t('servers.tmuxDialog.actions.confirmRename')}
                                                onClick={() => rename(win)}>
                                            <Icon path={mdiCheck} size={0.7} />
                                        </button>
                                        <button className="tmux-icon-button" disabled={busy !== null}
                                                title={t('servers.tmuxDialog.actions.cancelRename')}
                                                aria-label={t('servers.tmuxDialog.actions.cancelRename')}
                                                onClick={() => setRenaming(null)}>
                                            <Icon path={mdiClose} size={0.7} />
                                        </button>
                                    </div>
                                    {!nameOk && <p className="tmux-hint">{t('servers.tmuxDialog.windowNameHint')}</p>}
                                </li>
                            );
                        }

                        return (
                            <li key={win.id} className="tmux-session-row">
                                <button className="tmux-session-item" type="button" disabled={busy !== null}
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
                                <div className="tmux-session-actions">
                                    <button className="tmux-icon-button" disabled={busy !== null}
                                            title={t('servers.tmuxDialog.actions.windowRename')}
                                            aria-label={t('servers.tmuxDialog.actions.windowRename')}
                                            onClick={() => {
                                                setRenaming(win.id);
                                                // The raw name, not the sanitized one: the user should
                                                // rename what is actually there. Control characters in
                                                // it are caught by the name rule on submit.
                                                setRenameValue(win.name);
                                                setPendingKill(null);
                                            }}>
                                        <Icon path={mdiPencil} size={0.7} />
                                    </button>
                                    <button className="tmux-icon-button" disabled={busy !== null}
                                            title={t('servers.tmuxDialog.actions.windowKill')}
                                            aria-label={t('servers.tmuxDialog.actions.windowKill')}
                                            onClick={() => requestKill(win)}>
                                        <Icon path={mdiTrashCan} size={0.7} />
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            <div className="tmux-new-session">
                <input type="text" value={newName} maxLength={64}
                       placeholder={t('servers.tmuxDialog.newWindowPlaceholder')}
                       disabled={busy !== null}
                       onChange={(e) => setNewName(e.target.value)}
                       onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
                <Button text={t('servers.tmuxDialog.actions.windowCreate')}
                        disabled={busy !== null || (newName.length > 0 && !WINDOW_NAME_PATTERN.test(newName))}
                        onClick={create} />
            </div>
            {newName.length > 0 && !WINDOW_NAME_PATTERN.test(newName) && (
                <p className="tmux-hint">{t('servers.tmuxDialog.windowNameHint')}</p>
            )}
        </>
    );
};

export default TmuxWindowView;

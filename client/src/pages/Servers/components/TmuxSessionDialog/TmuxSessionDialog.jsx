import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import Icon from "@mdi/react";
import { mdiPencil, mdiTrashCan, mdiCheck, mdiClose } from "@mdi/js";
import { getRequest, deleteRequest, patchRequest } from "@/common/utils/RequestUtil.js";
import TmuxWindowView, { displayName } from "./TmuxWindowView.jsx";
import { emptyStateKey } from "./emptyState.js";
import "./styles.sass";

const CREATE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The window count as a 2x2 grid: four slots, filled with as many as are
 * occupied. From five windows on, all four are full - the exact number then
 * only lives in the title, which is accepted deliberately.
 */
const WindowGrid = ({ count }) => {
    const slots = [[2.5, 2.5], [13, 2.5], [2.5, 13], [13, 13]];
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            {slots.map(([x, y], i) => (
                <rect key={i} x={x} y={y} width="8.5" height="8.5" rx="1.6"
                      fill="currentColor" opacity={i < count ? 1 : 0.22} />
            ))}
        </svg>
    );
};

const TmuxSessionDialog = ({ isOpen, onClose, onSelect, onConnectRaw, entryId, identityId }) => {
    const { t } = useTranslation();
    const [state, setState] = useState({ status: "loading", sessions: [], error: null, available: true });
    const [newName, setNewName] = useState("");
    const [pendingKill, setPendingKill] = useState(null);
    const [renaming, setRenaming] = useState(null);
    const [renameValue, setRenameValue] = useState("");
    const [busyName, setBusyName] = useState(null);
    const [notice, setNotice] = useState(null);   // { text, failed }
    const [reloadToken, setReloadToken] = useState(0);
    // Name of the session whose windows are shown. null = session list.
    const [openSession, setOpenSession] = useState(null);

    useEffect(() => {
        if (!isOpen || !entryId) return;

        let cancelled = false;
        setState({ status: "loading", sessions: [], error: null, available: true });
        // Not made redundant by the remount: this effect also runs on
        // reloadToken, which every failed action bumps. An open confirmation or
        // a half-typed rename must not survive a reload whose list may have
        // changed underneath it.
        setPendingKill(null);
        setRenaming(null);

        const query = identityId ? `?identityId=${identityId}` : "";
        getRequest(`/entries/${entryId}/tmux${query}`)
            .then((result) => {
                if (cancelled) return;
                if (result.available === false) {
                    // A deliberate reversal of "a host without tmux must never block the
                    // way in": skipping straight to a raw shell left no time to read why
                    // the picker was of no use, and the toast was gone by the time the
                    // terminal had opened. The dialog now stays and states the reason;
                    // "connect without tmux" below is the very click the skip performed.
                    setState({
                        status: "ready", sessions: [], error: null,
                        available: false, reason: result.reason,
                    });
                    return;
                }
                setState({
                    status: "ready", sessions: result.sessions || [], error: null,
                    available: true, reason: result.reason,
                });
            })
            .catch((error) => {
                if (cancelled) return;
                setState({ status: "error", sessions: [], error: error?.message || String(error), available: true });
            });

        return () => { cancelled = true; };
    }, [isOpen, entryId, identityId, reloadToken]);

    // Deliberately not named `query`: the fetch effect already has a local of that
    // name. encodeURIComponent, never encodeURI — the latter leaves ? # and &
    // untouched, and tmux allows all three in session names.
    const paramQuery = (param, value) => {
        const identityPart = identityId ? `identityId=${identityId}&` : "";
        return `?${identityPart}${param}=${encodeURIComponent(value)}`;
    };
    const actionQuery = (name) => paramQuery("session", name);

    const applyResult = (result) => {
        // The list in hand is new; a confirmation or a half-typed rename from the
        // old list must not carry over onto a row that is no longer the same one.
        setPendingKill(null);
        setRenaming(null);

        if (result.refreshed === false) {
            setNotice({ text: t('servers.tmuxDialog.refreshFailed'), failed: false });
            return false;
        }
        setState({
            status: "ready", sessions: result.sessions || [], error: null,
            available: true, reason: result.reason,
        });
        setNotice(null);
        return true;
    };

    /**
     * A failed action must not park the dialog in a dead end: status "error" hides
     * the list and nothing would reload it, so the only way out would be closing
     * the dialog. The likeliest failure is "that session is gone" — the refreshed
     * list is the actual answer, so show the message and reload.
     */
    const failAction = (error) => {
        setNotice({ text: error?.message || String(error), failed: true });
        setReloadToken((token) => token + 1);
    };

    const killSession = async (name) => {
        if (busyName !== null) return;
        setBusyName(name);
        setPendingKill(null);
        try {
            const result = await deleteRequest(`/entries/${entryId}/tmux${actionQuery(name)}`);
            if (!applyResult(result)) {
                // The kill happened; only the refresh failed. Drop the row locally
                // so the user does not act on it a second time.
                setState((prev) => ({ ...prev, sessions: prev.sessions.filter((s) => s.name !== name) }));
            }
        } catch (error) {
            failAction(error);
        } finally {
            // Only the request that set the lock may clear it: if busyName is still
            // the name we locked, release it; otherwise a newer request already replaced it.
            setBusyName((prev) => (prev === name ? null : prev));
        }
    };

    const canCreate = CREATE_NAME_PATTERN.test(newName);
    const canRename = CREATE_NAME_PATTERN.test(renameValue);

    const startRename = (name) => {
        setRenaming(name);
        setRenameValue(name);
    };

    const renameSession = async (name) => {
        // Captured once: the input stays on screen for the whole request, so
        // renameValue can still change under an in-flight rename. The value we send
        // and the value we fall back to locally have to be the same one.
        const nextName = renameValue;
        if (busyName !== null || !CREATE_NAME_PATTERN.test(nextName)) return;

        // tmux treats a rename onto the identical name as a no-op with exit 0, so
        // the request would cost three exec round trips to change nothing.
        if (nextName === name) { setRenaming(null); return; }

        setBusyName(name);
        try {
            const result = await patchRequest(`/entries/${entryId}/tmux${actionQuery(name)}`, { name: nextName });
            setRenaming(null);
            if (!applyResult(result)) {
                setState((prev) => ({
                    ...prev,
                    sessions: prev.sessions.map((s) => (s.name === name ? { ...s, name: nextName } : s)),
                }));
            }
        } catch (error) {
            failAction(error);
        } finally {
            // Only the request that set the lock may clear it: if busyName is still
            // the name we locked, release it; otherwise a newer request already replaced it.
            setBusyName((prev) => (prev === name ? null : prev));
        }
    };

    const openedSession = openSession
        ? state.sessions.find((s) => s.name === openSession) || null
        : null;

    // Null when no sentence belongs in place of the list - which includes the
    // host-without-tmux case the old condition got wrong.
    const emptyKey = state.status === "ready" ? emptyStateKey(state) : null;

    // The session has vanished from underneath the open view - this is only
    // noticed on the next request, there is no background check for it.
    useEffect(() => {
        if (!openSession || state.status !== "ready" || openedSession) return;
        setNotice({ text: t('servers.tmuxDialog.sessionGone', { name: displayName(openSession) }), failed: true });
        setOpenSession(null);
    }, [openSession, openedSession, state.status]);

    return (
        <DialogProvider open={isOpen} onClose={onClose}>
            <div className="tmux-session-dialog">
                <h2>{t('servers.tmuxDialog.title')}</h2>

                {state.status === "loading" && <p className="tmux-status">{t('servers.tmuxDialog.loading')}</p>}

                {state.status === "error" && <p className="tmux-status tmux-error">{state.error}</p>}

                {notice && <p className={notice.failed ? "tmux-status tmux-error" : "tmux-status tmux-notice"}>{notice.text}</p>}

                {!openedSession && emptyKey && (
                    <p className="tmux-status">{t(emptyKey)}</p>
                )}

                {openedSession && (
                    <TmuxWindowView
                        session={openedSession}
                        entryId={entryId}
                        identityId={identityId}
                        onBack={() => setOpenSession(null)}
                        onConnect={(windowId) => onSelect(openedSession.name, false, windowId)}
                        onResult={applyResult}
                        onFailure={failAction}
                        onLocalRemove={(windowId) => setState((prev) => ({
                            ...prev,
                            sessions: prev.sessions.map((s) => (s.name === openedSession.name
                                ? { ...s, windowList: (s.windowList || []).filter((w) => w.id !== windowId) }
                                : s)),
                        }))}
                        onLocalRename={(windowId, name) => setState((prev) => ({
                            ...prev,
                            sessions: prev.sessions.map((s) => (s.name === openedSession.name
                                ? { ...s, windowList: (s.windowList || []).map((w) => (w.id === windowId ? { ...w, name } : w)) }
                                : s)),
                        }))}
                        onLastWindowClosed={(name) => {
                            // Taken here rather than through the sessionGone
                            // effect: that message is red, and the user just
                            // ended this session themselves, on purpose.
                            // Because openSession is already null by this
                            // point, the generic effect no longer applies at
                            // all.
                            setOpenSession(null);
                            setNotice({ text: t('servers.tmuxDialog.sessionEnded', { name: displayName(name) }), failed: false });
                        }}
                    />
                )}

                {!openedSession && state.status === "ready" && state.sessions.length > 0 && (
                    <ul className="tmux-session-list">
                        {state.sessions.map((session) => (
                            <li key={session.name} className="tmux-session-row">
                                {renaming === session.name ? (
                                    <div className="tmux-row-rename">
                                        <input type="text" value={renameValue} maxLength={64} autoFocus
                                               disabled={busyName !== null}
                                               onChange={(e) => setRenameValue(e.target.value)}
                                               onKeyDown={(e) => {
                                                   if (e.key === "Enter") renameSession(session.name);
                                                   if (e.key === "Escape") {
                                                       // DialogProvider closes the whole dialog on Escape via a
                                                       // native document-level keydown listener (see Dialog.jsx).
                                                       // React 19 delegates events at the portal container
                                                       // (document.body, which is where this dialog is portalled),
                                                       // and that delegated dispatch runs before the event reaches
                                                       // `document` in the real DOM bubble order. stopPropagation()
                                                       // here therefore stops the native event before it ever
                                                       // reaches DialogProvider's listener, so only the rename is
                                                       // cancelled and the dialog - and the connection attempt
                                                       // behind it - stays open.
                                                       e.stopPropagation();
                                                       setRenaming(null);
                                                   }
                                               }} />
                                        <button className="tmux-icon-button" disabled={busyName !== null || !canRename}
                                                title={t('servers.tmuxDialog.actions.confirmRename')}
                                                aria-label={t('servers.tmuxDialog.actions.confirmRename')}
                                                onClick={() => renameSession(session.name)}>
                                            <Icon path={mdiCheck} size={0.7} />
                                        </button>
                                        <button className="tmux-icon-button" disabled={busyName !== null}
                                                title={t('servers.tmuxDialog.actions.cancelRename')}
                                                aria-label={t('servers.tmuxDialog.actions.cancelRename')}
                                                onClick={() => setRenaming(null)}>
                                            <Icon path={mdiClose} size={0.7} />
                                        </button>
                                    </div>
                                ) : pendingKill === session.name ? (
                                    <div className="tmux-row-confirm">
                                        <span>{t('servers.tmuxDialog.killConfirm', { name: session.name, interpolation: { escapeValue: false } })}</span>
                                        <Button text={t('servers.tmuxDialog.actions.confirmKill')} disabled={busyName !== null}
                                                onClick={() => killSession(session.name)} />
                                        <Button type="secondary" text={t('servers.tmuxDialog.actions.cancelKill')}
                                                onClick={() => setPendingKill(null)} />
                                    </div>
                                ) : (
                                    <>
                                        <button className="tmux-session-item" disabled={busyName !== null}
                                                onClick={() => onSelect(session.name, false)}>
                                            <span className="tmux-session-name">{session.name}</span>
                                            <span className="tmux-session-meta">
                                                {session.attached && t('servers.tmuxDialog.attachedLabel')}
                                            </span>
                                        </button>
                                        <div className="tmux-session-actions">
                                            <button className="tmux-icon-button tmux-window-grid"
                                                    disabled={busyName !== null}
                                                    title={t('servers.tmuxDialog.windowsOpen', { count: session.windows })}
                                                    aria-label={t('servers.tmuxDialog.windowsOpen', { count: session.windows })}
                                                    onClick={() => setOpenSession(session.name)}>
                                                <WindowGrid count={Math.min(session.windows, 4)} />
                                            </button>
                                            <button className="tmux-icon-button"
                                                    disabled={busyName !== null}
                                                    title={t('servers.tmuxDialog.actions.rename')}
                                                    aria-label={t('servers.tmuxDialog.actions.rename')}
                                                    onClick={() => startRename(session.name)}>
                                                <Icon path={mdiPencil} size={0.7} />
                                            </button>
                                            <button className="tmux-icon-button"
                                                    disabled={busyName !== null}
                                                    title={t('servers.tmuxDialog.actions.kill')}
                                                    aria-label={t('servers.tmuxDialog.actions.kill')}
                                                    onClick={() => (session.attached ? setPendingKill(session.name) : killSession(session.name))}>
                                                <Icon path={mdiTrashCan} size={0.7} />
                                            </button>
                                        </div>
                                    </>
                                )}
                                {renaming === session.name && !canRename && (
                                    <p className="tmux-hint">{t('servers.tmuxDialog.nameHint')}</p>
                                )}
                            </li>
                        ))}
                    </ul>
                )}

                {!openedSession && (
                    <div className="tmux-new-session">
                        <input type="text" value={newName} maxLength={64}
                               placeholder={t('servers.tmuxDialog.newSessionPlaceholder')}
                               disabled={busyName !== null}
                               onChange={(e) => setNewName(e.target.value)}
                               onKeyDown={(e) => { if (e.key === "Enter" && canCreate && busyName === null) onSelect(newName, true); }} />
                        <Button text={t('servers.tmuxDialog.actions.create')} disabled={!canCreate || busyName !== null}
                                onClick={() => onSelect(newName, true)} />
                    </div>
                )}
                {!openedSession && newName.length > 0 && !canCreate && <p className="tmux-hint">{t('servers.tmuxDialog.nameHint')}</p>}

                <div className="dialog-actions">
                    <Button type="secondary" text={t('servers.tmuxDialog.actions.cancel')} onClick={onClose} />
                    <Button type="secondary" text={t('servers.tmuxDialog.actions.connectRaw')} disabled={busyName !== null}
                            onClick={onConnectRaw} />
                </div>
            </div>
        </DialogProvider>
    );
};

export default TmuxSessionDialog;

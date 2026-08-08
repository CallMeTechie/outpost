import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import Icon from "@mdi/react";
import { mdiPencil, mdiTrashCan, mdiCheck, mdiClose } from "@mdi/js";
import { getRequest, deleteRequest, patchRequest } from "@/common/utils/RequestUtil.js";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import "./styles.sass";

const CREATE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const TmuxSessionDialog = ({ isOpen, onClose, onSelect, onConnectRaw, entryId, identityId }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const [state, setState] = useState({ status: "loading", sessions: [], error: null, available: true });
    const [newName, setNewName] = useState("");
    const [pendingKill, setPendingKill] = useState(null);
    const [renaming, setRenaming] = useState(null);
    const [renameValue, setRenameValue] = useState("");
    const [busyName, setBusyName] = useState(null);
    const [notice, setNotice] = useState(null);   // { text, failed }
    const [reloadToken, setReloadToken] = useState(0);

    // onConnectRaw is a fresh closure from the parent on every render. Reaching it
    // through a ref keeps the fetch effect's dependency array honest (no re-fetch
    // on every render) while still calling the latest callback below.
    const onConnectRawRef = useRef(onConnectRaw);
    useEffect(() => {
        onConnectRawRef.current = onConnectRaw;
    }, [onConnectRaw]);

    // The dialog is only ever hidden, never unmounted (see the comment above),
    // and its Cancel/close button is deliberately left enabled while a kill is
    // in flight. That means a DELETE issued for one host can still resolve
    // after the dialog has been closed and reopened for a different one.
    // entryIdRef always holds the host currently on screen, so killSession can
    // tell a fresh response from a stale one.
    const entryIdRef = useRef(entryId);
    useEffect(() => {
        entryIdRef.current = entryId;
    }, [entryId]);

    useEffect(() => {
        if (!isOpen || !entryId) return;

        let cancelled = false;
        setState({ status: "loading", sessions: [], error: null, available: true });
        setPendingKill(null);
        setRenaming(null);

        const query = identityId ? `?identityId=${identityId}` : "";
        getRequest(`/entries/${entryId}/tmux${query}`)
            .then((result) => {
                if (cancelled) return;
                if (result.available === false) {
                    setState({ status: "ready", sessions: [], error: null, available: false });
                    // A host without tmux must never block the way in: skip straight to a
                    // normal shell, but say so once so the toggle doesn't look broken.
                    sendToast("Info", t('servers.tmuxDialog.notInstalled'));
                    onConnectRawRef.current();
                    return;
                }
                setState({ status: "ready", sessions: result.sessions || [], error: null, available: true });
            })
            .catch((error) => {
                if (cancelled) return;
                setState({ status: "error", sessions: [], error: error?.message || String(error), available: true });
            });

        return () => { cancelled = true; };
    }, [isOpen, entryId, identityId, reloadToken, sendToast, t]);

    // Cleared when the dialog opens, not on every load: a failed action triggers a
    // reload, and its message is exactly what the user needs to read afterwards.
    // busyName belongs here too: it is set synchronously when an action starts but
    // only cleared in that action's own `finally`, so without this reset a kill or
    // rename left in flight on one host would leave the picker for the next host
    // opened - however unrelated - locked until that old request finally settles.
    useEffect(() => {
        if (isOpen) { setNotice(null); setNewName(""); setBusyName(null); }
    }, [isOpen]);

    // Deliberately not named `query`: the fetch effect already has a local of that
    // name. encodeURIComponent, never encodeURI — the latter leaves ? # and &
    // untouched, and tmux allows all three in session names.
    const actionQuery = (name) => {
        const identityPart = identityId ? `identityId=${identityId}&` : "";
        return `?${identityPart}session=${encodeURIComponent(name)}`;
    };

    const applyResult = (result) => {
        // The list in hand is new; a confirmation or a half-typed rename from the
        // old list must not carry over onto a row that is no longer the same one.
        setPendingKill(null);
        setRenaming(null);

        if (result.refreshed === false) {
            setNotice({ text: t('servers.tmuxDialog.refreshFailed'), failed: false });
            return false;
        }
        setState({ status: "ready", sessions: result.sessions || [], error: null, available: true });
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
        // Captured now, compared against entryIdRef.current once the request
        // settles: if the dialog has since been reopened for another host, this
        // response belongs to a host that is no longer on screen and must not
        // touch state, notice, or the local row removal below.
        const requestEntryId = entryId;
        try {
            const result = await deleteRequest(`/entries/${entryId}/tmux${actionQuery(name)}`);
            if (entryIdRef.current !== requestEntryId) return;
            if (!applyResult(result)) {
                // The kill happened; only the refresh failed. Drop the row locally
                // so the user does not act on it a second time.
                setState((prev) => ({ ...prev, sessions: prev.sessions.filter((s) => s.name !== name) }));
            }
        } catch (error) {
            if (entryIdRef.current !== requestEntryId) return;
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
        // Captured now, compared against entryIdRef.current once the request
        // settles: if the dialog has since been reopened for another host, this
        // response belongs to a host that is no longer on screen and must not
        // touch state, notice, or the local row rename below.
        const requestEntryId = entryId;
        try {
            const result = await patchRequest(`/entries/${entryId}/tmux${actionQuery(name)}`, { name: nextName });
            if (entryIdRef.current !== requestEntryId) return;
            setRenaming(null);
            if (!applyResult(result)) {
                setState((prev) => ({
                    ...prev,
                    sessions: prev.sessions.map((s) => (s.name === name ? { ...s, name: nextName } : s)),
                }));
            }
        } catch (error) {
            if (entryIdRef.current !== requestEntryId) return;
            failAction(error);
        } finally {
            // Only the request that set the lock may clear it: if busyName is still
            // the name we locked, release it; otherwise a newer request already replaced it.
            setBusyName((prev) => (prev === name ? null : prev));
        }
    };

    return (
        <DialogProvider open={isOpen} onClose={onClose}>
            <div className="tmux-session-dialog">
                <h2>{t('servers.tmuxDialog.title')}</h2>

                {state.status === "loading" && <p className="tmux-status">{t('servers.tmuxDialog.loading')}</p>}

                {state.status === "error" && <p className="tmux-status tmux-error">{state.error}</p>}

                {notice && <p className={notice.failed ? "tmux-status tmux-error" : "tmux-status tmux-notice"}>{notice.text}</p>}

                {state.status === "ready" && state.sessions.length === 0 && (
                    <p className="tmux-status">{t('servers.tmuxDialog.empty')}</p>
                )}

                {state.status === "ready" && state.sessions.length > 0 && (
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
                                                {t('servers.tmuxDialog.windows', { count: session.windows })}
                                                {session.attached && ` · ${t('servers.tmuxDialog.attachedLabel')}`}
                                            </span>
                                        </button>
                                        <div className="tmux-session-actions">
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

                <div className="tmux-new-session">
                    <input type="text" value={newName} maxLength={64}
                           placeholder={t('servers.tmuxDialog.newSessionPlaceholder')}
                           disabled={busyName !== null}
                           onChange={(e) => setNewName(e.target.value)}
                           onKeyDown={(e) => { if (e.key === "Enter" && canCreate && busyName === null) onSelect(newName, true); }} />
                    <Button text={t('servers.tmuxDialog.actions.create')} disabled={!canCreate || busyName !== null}
                            onClick={() => onSelect(newName, true)} />
                </div>
                {newName.length > 0 && !canCreate && <p className="tmux-hint">{t('servers.tmuxDialog.nameHint')}</p>}

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

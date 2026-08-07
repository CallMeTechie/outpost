import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import Icon from "@mdi/react";
import { mdiPencil, mdiTrashCan } from "@mdi/js";
import { getRequest } from "@/common/utils/RequestUtil.js";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import "./styles.sass";

const CREATE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const TmuxSessionDialog = ({ isOpen, onClose, onSelect, onConnectRaw, entryId, identityId }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const [state, setState] = useState({ status: "loading", sessions: [], error: null, available: true });
    const [newName, setNewName] = useState("");

    // onConnectRaw is a fresh closure from the parent on every render. Reaching it
    // through a ref keeps the fetch effect's dependency array honest (no re-fetch
    // on every render) while still calling the latest callback below.
    const onConnectRawRef = useRef(onConnectRaw);
    useEffect(() => {
        onConnectRawRef.current = onConnectRaw;
    }, [onConnectRaw]);

    useEffect(() => {
        if (!isOpen || !entryId) return;

        let cancelled = false;
        setState({ status: "loading", sessions: [], error: null, available: true });
        setNewName("");

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
    }, [isOpen, entryId, identityId, sendToast, t]);

    const canCreate = CREATE_NAME_PATTERN.test(newName);

    return (
        <DialogProvider open={isOpen} onClose={onClose}>
            <div className="tmux-session-dialog">
                <h2>{t('servers.tmuxDialog.title')}</h2>

                {state.status === "loading" && <p className="tmux-status">{t('servers.tmuxDialog.loading')}</p>}

                {state.status === "error" && <p className="tmux-status tmux-error">{state.error}</p>}

                {state.status === "ready" && state.sessions.length === 0 && (
                    <p className="tmux-status">{t('servers.tmuxDialog.empty')}</p>
                )}

                {state.status === "ready" && state.sessions.length > 0 && (
                    <ul className="tmux-session-list">
                        {state.sessions.map((session) => (
                            <li key={session.name} className="tmux-session-row">
                                <button className="tmux-session-item" onClick={() => onSelect(session.name, false)}>
                                    <span className="tmux-session-name">{session.name}</span>
                                    <span className="tmux-session-meta">
                                        {t('servers.tmuxDialog.windows', { count: session.windows })}
                                        {session.attached && ` · ${t('servers.tmuxDialog.attachedLabel')}`}
                                    </span>
                                </button>
                                <div className="tmux-session-actions">
                                    <button className="tmux-icon-button"
                                            title={t('servers.tmuxDialog.actions.rename')}
                                            aria-label={t('servers.tmuxDialog.actions.rename')}>
                                        <Icon path={mdiPencil} size={0.7} />
                                    </button>
                                    <button className="tmux-icon-button"
                                            title={t('servers.tmuxDialog.actions.kill')}
                                            aria-label={t('servers.tmuxDialog.actions.kill')}>
                                        <Icon path={mdiTrashCan} size={0.7} />
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}

                <div className="tmux-new-session">
                    <input type="text" value={newName} maxLength={64}
                           placeholder={t('servers.tmuxDialog.newSessionPlaceholder')}
                           onChange={(e) => setNewName(e.target.value)}
                           onKeyDown={(e) => { if (e.key === "Enter" && canCreate) onSelect(newName, true); }} />
                    <Button text={t('servers.tmuxDialog.actions.create')} disabled={!canCreate}
                            onClick={() => onSelect(newName, true)} />
                </div>
                {newName.length > 0 && !canCreate && <p className="tmux-hint">{t('servers.tmuxDialog.nameHint')}</p>}

                <div className="dialog-actions">
                    <Button type="secondary" text={t('servers.tmuxDialog.actions.cancel')} onClick={onClose} />
                    <Button type="secondary" text={t('servers.tmuxDialog.actions.connectRaw')} onClick={onConnectRaw} />
                </div>
            </div>
        </DialogProvider>
    );
};

export default TmuxSessionDialog;

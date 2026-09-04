import "./styles.sass";
import ServerList from "@/pages/Servers/components/ServerList";
import { useContext, useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import WelcomePanel from "@/pages/Servers/components/WelcomePanel";
import ServerDialog from "@/pages/Servers/components/ServerDialog";
import ViewContainer from "@/pages/Servers/components/ViewContainer";
import ProxmoxDialog from "@/pages/Servers/components/ProxmoxDialog";
import SSHConfigImportDialog from "@/pages/Servers/components/SSHConfigImportDialog";
import ConnectionReasonDialog from "@/pages/Servers/components/ConnectionReasonDialog";
import TmuxSessionDialog from "@/pages/Servers/components/TmuxSessionDialog";
import DirectConnectDialog from "@/pages/Servers/components/DirectConnectDialog";
import FileEditorWindow from "@/common/components/FileEditorWindow";
import FilePreviewWindow from "@/common/components/FilePreviewWindow";
import { useActiveSessions } from "@/common/contexts/SessionContext.jsx";
import { useLiveSessions } from "@/common/contexts/LiveSessionContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useLocation, useNavigate } from "react-router-dom";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { StateStreamContext, STATE_TYPES } from "@/common/contexts/StateStreamContext.jsx";
import { isTauri } from "@/common/utils/TauriUtil.js";
import { getTabId, getBrowserId, requiresIdentity, canConnectWithoutPrompt } from "@/common/utils/ConnectionUtil.js";
import { getRequest, postRequest, deleteRequest } from "@/common/utils/RequestUtil";
import {
    toLocalSessionDescriptor, restoreLocalSessions, getStoredLocalSessionDescriptors, setStoredLocalSessionDescriptors,
    canPersistLocalSessions, RESTORE_STATUS,
} from "@/common/utils/localSessionState.js";
import { getStoredTabIdentities, setStoredTabIdentities, selectEvictions, TAB_IDENTITY_CAP, normalizeTabName } from "@/common/utils/tabIdentity.js";
import { assignNumbers, diffAssignments, tabGroupKey, tabIdentitySignature } from "@/common/utils/tabLabel.js";

// A session the server does not know about: it lives in this browser only. The poll below
// replaces the session list with what the server reports, so anything matching this has to be
// carried over by hand — otherwise it vanishes without anyone closing it.
const isLocalSession = (session) => session?.type === "notes" || session?.type === "onedrive";

export const Servers = () => {

    const [serverDialogOpen, setServerDialogOpen] = useState(false);
    const [serverDialogProtocol, setServerDialogProtocol] = useState(null);
    const [proxmoxDialogOpen, setProxmoxDialogOpen] = useState(false);
    const [sshConfigImportDialogOpen, setSSHConfigImportDialogOpen] = useState(false);
    const [connectionReasonDialogOpen, setConnectionReasonDialogOpen] = useState(false);
    const [tmuxDialogOpen, setTmuxDialogOpen] = useState(false);
    // Bumped on every open so the dialog remounts with fresh state. Without it
    // the component stays mounted while merely hidden, and a lock or an open
    // window view survives into the next host - the cause behind three separate
    // bugs in the window management work.
    //
    // This only works as long as openTmuxDialog below stays the ONLY way in.
    // Nothing enforces that; a future setTmuxDialogOpen(true) elsewhere would
    // silently reintroduce all three bugs.
    const [tmuxDialogKey, setTmuxDialogKey] = useState(0);
    const [pendingTmuxConnection, setPendingTmuxConnection] = useState(null);
    const [directConnectDialogOpen, setDirectConnectDialogOpen] = useState(false);
    const [directConnectServer, setDirectConnectServer] = useState(null);
    const [pendingConnection, setPendingConnection] = useState(null);
    const [openFileEditors, setOpenFileEditors] = useState([]);
    const [mobileServerListOpen, setMobileServerListOpen] = useState(false);
    const [leftPaneSlot, setLeftPaneSlot] = useState(null);

    const [currentFolderId, setCurrentFolderId] = useState(null);
    const [currentOrganizationId, setCurrentOrganizationId] = useState(null);
    const [editServerId, setEditServerId] = useState(null);
    const { activeSessions, setActiveSessions, activeSessionId, setActiveSessionId, poppedOutSessions } = useActiveSessions();
    const { liveSessions } = useLiveSessions();
    const { getServerById, servers } = useContext(ServerContext);
    const { registerHandler } = useContext(StateStreamContext);
    const { sendToast } = useToast();
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();

    const [hibernatedSessions, setHibernatedSessions] = useState([]);
    const closingSessionsRef = useRef(new Set());
    const erroredSessionsRef = useRef(new Map());

    // Read once, during the first render, so restore always works from what was actually on
    // disk at mount - not from whatever the save effect below might have written by the time
    // the restore effect gets to run.
    const [initialLocalDescriptors] = useState(() => getStoredLocalSessionDescriptors());
    const hasRestoredLocalSessionsRef = useRef(false);
    // The save effect is gated on this: it may only overwrite localStorage once restore has
    // read a complete picture (RESTORE_STATUS.READY). PENDING covers the render(s) before that;
    // FAILED covers the connections request restore needs failing outright (network, expired
    // token) - in both cases writing now would mean writing an incomplete list over a complete
    // one, which is the data-loss bug this state exists to rule out.
    const [restoreStatus, setRestoreStatus] = useState(RESTORE_STATUS.PENDING);

    // Read synchronously, same reasoning as initialLocalDescriptors above: the first paint after
    // a hard reload must already know last session's numbers, or two same-named tabs would flash
    // unnumbered before the effect further down catches up.
    const [tabIdentities, setTabIdentities] = useState(() => getStoredTabIdentities());

    const markSessionErrored = useCallback((sessionId, message) => {
        if (erroredSessionsRef.current.has(sessionId)) return;
        erroredSessionsRef.current.set(sessionId, message);
    }, []);

    const getSessionError = useCallback((sessionId) => {
        return erroredSessionsRef.current.get(sessionId) || null;
    }, []);

    const visibleSessions = activeSessions.filter(s => !poppedOutSessions.includes(s.id));

    useEffect(() => {
        const handleToggle = () => setMobileServerListOpen(prev => !prev);
        window.addEventListener('toggleServerList', handleToggle);
        return () => window.removeEventListener('toggleServerList', handleToggle);
    }, []);

    useEffect(() => {
        setLeftPaneSlot(document.getElementById("left-pane-slot"));
    }, []);

    const handleConnectionsUpdate = useCallback((sessions) => {
        if (!servers) return;
        const mappedSessions = sessions.map(session => {
            // A one-off connection has no entry to look up. Its target rides on
            // the session, so the same stand-in is rebuilt here -- otherwise the
            // next broadcast would drop the tab the user is looking at.
            const directTarget = session.configuration?.directTarget;
            const server = directTarget
                ? {
                    id: null,
                    name: `${directTarget.host}:${directTarget.port}`,
                    directTarget,
                    renderer: "terminal",
                    type: "server",
                    config: { ip: directTarget.host, port: directTarget.port, protocol: directTarget.protocol },
                }
                : getServerById(session.entryId);
            if (!server) return null;
            return {
                id: session.sessionId,
                server,
                identity: session.configuration.identityId,
                isHibernated: session.isHibernated,
                lastActivity: session.lastActivity,
                type: session.configuration.type || undefined,
                tmuxSession: session.configuration.tmuxSession || undefined,
                tmuxWindowId: session.configuration.tmuxWindowId || undefined,
                organizationId: session.organizationId,
                organizationName: session.organizationName,
                osName: session.osName || null,
                scriptId: session.configuration.scriptId || undefined,
                shareId: session.shareId || null,
                shareWritable: session.shareWritable || false,
                participants: session.participants || [],
            };
        }).filter(Boolean);

        const closingSessions = closingSessionsRef.current;
        const activeMapped = mappedSessions.filter(s => !s.isHibernated && !closingSessions.has(s.id));
        const hibernatedMapped = mappedSessions.filter(s => s.isHibernated);
        
        const serverSessionIds = new Set(sessions.map(s => s.sessionId));
        closingSessions.forEach(id => {
            if (!serverSessionIds.has(id)) {
                closingSessions.delete(id);
            }
        });
        
        const newActiveIds = new Set(activeMapped.map(s => s.id));
        let mergedSessions = [];

        setActiveSessions(prev => {
            const prevMap = new Map(prev.map(s => [s.id, s]));
            const localOnly = prev.filter(s => isLocalSession(s) || s.isJoined);
            const merged = activeMapped.map(newSession => {
                const existing = prevMap.get(newSession.id);
                return existing ? { ...newSession, scriptId: existing.scriptId || newSession.scriptId, scriptName: existing.scriptName, osName: newSession.osName || existing.osName } : newSession;
            });
            const mergedIds = new Set(merged.map(s => s.id));
            const erroredPinned = prev.filter(s =>
                erroredSessionsRef.current.has(s.id) && !mergedIds.has(s.id) && !isLocalSession(s)
            );
            mergedSessions = [...merged, ...erroredPinned, ...localOnly];
            return mergedSessions;
        });
        // scriptName never comes from the server - session.configuration only ever carries
        // scriptId (server/controllers/serverSession.js), so performConnection is the only place
        // that ever learns it. The active path above already rescues it from the previous list on
        // every broadcast; without the same rescue here, hibernating a scripted session drops the
        // name and it stays dropped after waking, since the woken session is new to activeSessions
        // and the rescue at :150 has nothing to carry it forward from.
        setHibernatedSessions(prev => {
            const prevMap = new Map(prev.map(s => [s.id, s]));
            return hibernatedMapped.map(newSession => {
                const existing = prevMap.get(newSession.id);
                return existing ? { ...newSession, scriptName: existing.scriptName } : newSession;
            });
        });

        setActiveSessionId(prev => {
            if (prev && (newActiveIds.has(prev) || mergedSessions.some(s => s.id === prev))) return prev;
            return mergedSessions.at(-1)?.id || null;
        });
    }, [servers, getServerById, setActiveSessions, setActiveSessionId]);

    useEffect(() => {
        if (servers) return registerHandler(STATE_TYPES.CONNECTIONS, handleConnectionsUpdate);
    }, [servers, registerHandler, handleConnectionsUpdate]);

    // Persist whatever local-only tabs (OneDrive, notes) are open right now, on every change -
    // but only once restore has read a complete picture (see canPersistLocalSessions). Writing
    // while PENDING would overwrite the stored descriptors before restore ever gets to read
    // them; writing after FAILED would overwrite them with a list known to be incomplete,
    // since the restore that needed the connections request never got to run. Writing the
    // descriptor, not the session object, means a rename picked up later never gets replayed
    // stale - restoreLocalSessions looks the current details up fresh.
    useEffect(() => {
        if (!canPersistLocalSessions(restoreStatus)) return;
        setStoredLocalSessionDescriptors(activeSessions.map(toLocalSessionDescriptor).filter(Boolean));
    }, [activeSessions, restoreStatus]);

    // Runs once, after `servers` is available (getServerById needs it) - the terminal/sftp tabs
    // themselves arrive separately via handleConnectionsUpdate, which always puts freshly synced
    // sessions ahead of any local-only ones it finds already in place, so appending here rather
    // than racing that update is enough to keep server-backed tabs first regardless of which
    // finishes loading first. Connections are fetched here rather than threaded down from
    // OneDriveAccounts, since that component doesn't run until the sidebar renders its list.
    // Every setState call below - including the READY transition when there's nothing to
    // restore - lives inside a promise callback, not the effect body itself, matching how the
    // rest of this file fetches on mount; that's what keeps them out of
    // react-hooks/set-state-in-effect, and it's also what makes each one safe to reorder with
    // the save effect above.
    useEffect(() => {
        if (!servers || hasRestoredLocalSessionsRef.current) return;
        hasRestoredLocalSessionsRef.current = true;

        if (initialLocalDescriptors.length === 0) {
            Promise.resolve().then(() => setRestoreStatus(RESTORE_STATUS.READY));
            return;
        }

        getRequest("microsoft/connections")
            .then(connections => {
                const restored = restoreLocalSessions(initialLocalDescriptors, { connections, getServerById });
                setRestoreStatus(RESTORE_STATUS.READY);
                if (restored.length === 0) return;
                setActiveSessions(prev => [...prev, ...restored.filter(s => !prev.some(p => p.id === s.id))]);
            })
            .catch(error => {
                console.error("Failed to restore local sessions", error);
                setRestoreStatus(RESTORE_STATUS.FAILED);
            });
    }, [servers, initialLocalDescriptors, getServerById, setActiveSessions]);

    // Mirrors tabIdentities and the combined active+hibernated session list into refs so the
    // numbering effect below can read their latest values without listing them as dependencies.
    // Depending on the arrays themselves would re-run numbering on every unrelated session-list
    // update - a lastActivity tick, osName arriving late from a snapshot, and - once the live
    // terminal title lands - a title that can change several times a second.
    const tabIdentitiesRef = useRef(tabIdentities);
    useEffect(() => {
        tabIdentitiesRef.current = tabIdentities;
    }, [tabIdentities]);

    const sessionsForNumberingRef = useRef([...activeSessions, ...hibernatedSessions]);
    useEffect(() => {
        sessionsForNumberingRef.current = [...activeSessions, ...hibernatedSessions];
    }, [activeSessions, hibernatedSessions]);

    // Everything that can move a tab's number, as one primitive React can compare by value: it
    // stays "the same" across renders where none of those fields moved, even though the session
    // arrays it is built from are new objects every time.
    //
    // The composition itself lives in tabLabel.js, next to the grouping rule it has to track. It
    // used to be spelled out here as a hand-picked field list, and that list drifted from the rule
    // twice: first it was missing the custom name, then the server name, each time letting a tab
    // keep a number it should have lost. A list kept in a different file from the rule it mirrors
    // is a list that will drift again.
    const sessionsForIdentity = [...activeSessions, ...hibernatedSessions];
    const identitySignature = tabIdentitySignature(sessionsForIdentity, tabIdentities);

    // Tab numbers, computed synchronously during render rather than only in the persistence
    // effect below - without this, a freshly opened tab paints one frame with no number before
    // that effect catches up, visible for any tab that collides by name. This follows React's own
    // "adjust state while rendering" pattern (a state value plus a comparison against the previous
    // render's signature) instead of useMemo: a useMemo body would need to close over tabIdentities
    // and sessionsForIdentity without listing them as dependencies to get the same narrowing the
    // effect's refs give it, and this project's eslint-plugin-react-hooks (react-hooks/refs)
    // forbids reading a ref during render at all - only an effect may do that, so the ref trick
    // that works for the persistence effect below has no render-phase equivalent here. Calling
    // setState mid-render like this makes React discard this render and immediately re-render
    // with the new state before anything paints, so there is still no visible flash - and it still
    // only recomputes when identitySignature actually changes, never on an unrelated re-render (a
    // lastActivity tick, or, once Task 7 lands, a live title update).
    const [numberedSignature, setNumberedSignature] = useState(identitySignature);
    const [tabNumbers, setTabNumbers] = useState(() => assignNumbers(sessionsForIdentity, tabIdentities));
    if (identitySignature !== numberedSignature) {
        setNumberedSignature(identitySignature);
        setTabNumbers(assignNumbers(sessionsForIdentity, tabIdentities));
    }

    // Persists whatever tabNumbers just changed. This no longer computes the numbers itself - it
    // reads the exact same map the render above already produced, so what a tab shows and what
    // gets written to storage can never disagree. Hibernated sessions are included on exactly the
    // same footing as active ones here, and again below as protected ids: a session asleep in the
    // background is still "open" from the identity store's point of view, so it keeps its slot in
    // its name group and can never be evicted by the cap while it sleeps - waking it up must not
    // change its name or number.
    useEffect(() => {
        const sessions = sessionsForNumberingRef.current;
        const identities = tabIdentitiesRef.current;
        const nextNumbers = tabNumbers;

        const previousNumbers = {};
        for (const session of sessions) previousNumbers[session.id] = identities[session.id]?.number;

        // The loop brake: assignNumbers is idempotent, so re-running this after the write below
        // (tabIdentities changing doesn't retrigger this effect, but an unrelated render might
        // still land here with nothing new) computes the exact same numbers and stops here
        // instead of writing again.
        if (!diffAssignments(previousNumbers, nextNumbers)) return;

        // The group goes to storage with the number it belongs to, and only ever together with
        // it. assignNumbers needs it to know which group a number reserves once the session is
        // gone from the list - by then nothing is left to recompute the group from. Writing it
        // only here, where the number itself is written, keeps the pair honest: an entry either
        // has both or neither, and a group left behind by a session whose number was cleared
        // (a rename) reserves nothing, because a reservation needs a valid number too.
        const updates = {};
        for (const session of sessions) {
            if (previousNumbers[session.id] !== nextNumbers[session.id]) {
                updates[session.id] = {
                    ...identities[session.id],
                    number: nextNumbers[session.id],
                    group: tabGroupKey(session, identities[session.id]),
                    usedAt: Date.now(),
                };
            }
        }

        const merged = { ...identities, ...updates };
        const protectedIds = sessions.map((session) => session.id);
        // Setting an id to undefined here, rather than deleting it, is what actually removes it
        // from storage: setStoredTabIdentities re-reads and shallow-merges before writing, and
        // JSON.stringify drops properties whose value is undefined, so this is how an entry
        // leaves localStorage instead of only being dropped from this component's own state.
        for (const id of selectEvictions(merged, protectedIds, TAB_IDENTITY_CAP)) {
            updates[id] = undefined;
            delete merged[id];
        }

        // Deferred to a microtask, same as the restore effect above - this is what keeps a
        // synchronous setState call out of react-hooks/set-state-in-effect.
        Promise.resolve().then(() => {
            setStoredTabIdentities(updates);
            setTabIdentities(merged);
        });
    }, [tabNumbers]);

    // The write path for a hand-typed tab name - the only one, so ServerTabs never touches
    // tabIdentities or localStorage directly. normalizeTabName does the validation (trim, strip,
    // cap at 40, undefined for empty/whitespace-only) - not this function and not the dialog -
    // so clearing the field and saving is what resets a tab to its automatic name.
    //
    // The stored number is dropped when - and only when - the name actually changes. It is the
    // clean trigger for renumbering into the session's new (or newly automatic) name group, since
    // the group key is built from the name; assignNumbers' second pass, which resolves a
    // same-number collision by list order, exists as a safety net for cases this can't see (two
    // names colliding without either being freshly renamed), not as the normal path here.
    //
    // Dropping it unconditionally looked harmless and was not: confirming the dialog without
    // editing anything leaves the name, and therefore the identity signature, exactly as it was,
    // so no renumbering runs to put a number back. The state said "no number" while the tab still
    // showed the old one from tabNumbers, until the next tab opened or the page reloaded - at
    // which point the tab silently changed its text with nothing the user did touching it. That is
    // criterion 3, the load-bearing one.
    const renameSession = useCallback((sessionId, rawValue) => {
        const name = normalizeTabName(rawValue);
        const previous = tabIdentities[sessionId];
        const nameChanged = previous?.name !== name;
        const entry = nameChanged
            ? { ...previous, name, number: undefined, group: undefined, usedAt: Date.now() }
            : { ...previous, name, usedAt: Date.now() };

        setStoredTabIdentities({ [sessionId]: entry });

        // setStoredTabIdentities swallows a failed write (quota exceeded, storage disabled in
        // private mode) and only logs a warning - reading the entry straight back is the only
        // way from out here to tell whether it actually landed. Without this check the rename
        // would still look like it worked for the rest of this session and then silently
        // revert on the next reload, with nothing to explain why.
        //
        // Compared on `usedAt`, not `name`: `name` breaks down for exactly the reset-to-automatic
        // case, where the intended value is `undefined` - a storage read that failed outright
        // also reports `undefined` (getStoredTabIdentities' own catch-all returns `{}`), so the
        // two would be indistinguishable. `usedAt` is a fresh Date.now() set above on every call
        // and can only read back equal if that exact write actually reached storage, so it stays
        // a reliable signal for every value `name` can take, reset included.
        const persisted = getStoredTabIdentities()[sessionId];
        if (persisted?.usedAt !== entry.usedAt) {
            sendToast("Error", t("servers.tabs.renameDialog.saveFailed"));
        }

        setTabIdentities(prev => ({ ...prev, [sessionId]: entry }));
    }, [tabIdentities, sendToast, t]);

    const findOrganizationForServer = (serverIdNum, entries, currentOrg = null) => {
        for (const entry of entries) {
            if ((entry.type === "server" || entry.type === "pve-server") && entry.id === serverIdNum) {
                return currentOrg;
            } else if (entry.type === "organization") {
                const found = findOrganizationForServer(serverIdNum, entry.entries, entry);
                if (found) return found;
            } else if (entry.type === "folder" && entry.entries) {
                const found = findOrganizationForServer(serverIdNum, entry.entries, currentOrg);
                if (found) return found;
            }
        }
        return null;
    };

    // Any organization in the tree that demands a reason. Used for a connection
    // that has no entry to look the policy up from.
    const anyOrganizationRequiresReason = (entries) => {
        for (const entry of entries || []) {
            if (entry.type === "organization") {
                if (entry.requireConnectionReason) return true;
                if (anyOrganizationRequiresReason(entry.entries)) return true;
            } else if (entry.type === "folder" && entry.entries) {
                if (anyOrganizationRequiresReason(entry.entries)) return true;
            }
        }
        return false;
    };

    const checkConnectionReasonRequired = (serverId, servers) => {
        if (!servers) return false;

        // A one-off connection has no entry, so the policy comes from the
        // user's own organizations -- the same source the server reads it from
        // (directConnectionReasonRequired, over the account's memberships).
        // Without this the server would answer 400 and the user would have no
        // way to supply what it asks for.
        if (!serverId) return anyOrganizationRequiresReason(servers);

        return findOrganizationForServer(parseInt(serverId), servers)?.requireConnectionReason || false;
    };

    const connectToServer = async (serverId, identity, overrideRenderer) => {
        const server = getServerById(serverId);

        const hibernated = hibernatedSessions.find(s => s.server.id === serverId && s.identity === identity?.id);
        if (hibernated) {
            resumeConnection(hibernated.id);
            return;
        }

        if (server && !canConnectWithoutPrompt(server)) {
            openDirectConnect(server);
            return;
        }

        initiateConnection({ server: { ...server, renderer: overrideRenderer || server.renderer }, identity });
    };

    useEffect(() => {
        const liveIds = new Set(liveSessions.map(session => session.id));
        const staleIds = new Set(activeSessions
            .filter(s => s.isJoined && !liveIds.has(s.joinSessionId))
            .map(s => s.id));
        if (!staleIds.size) return;

        const remaining = activeSessions.filter(s => !staleIds.has(s.id));
        setActiveSessions(remaining);
        setActiveSessionId(current => staleIds.has(current) ? remaining.at(-1)?.id || null : current);
    }, [liveSessions, activeSessions, setActiveSessions, setActiveSessionId]);

    const joinLiveSession = (liveSession) => {
        const tabId = `join-${liveSession.id}`;

        setActiveSessions(prevSessions => {
            if (prevSessions.some(s => s.id === tabId)) return prevSessions;
            return [...prevSessions, {
                id: tabId,
                joinSessionId: liveSession.id,
                isJoined: true,
                writable: liveSession.writable,
                owner: liveSession.owner,
                server: {
                    id: liveSession.entryId,
                    name: liveSession.entryName,
                    icon: liveSession.icon,
                    type: liveSession.protocol,
                    renderer: liveSession.renderer,
                },
                type: liveSession.type || undefined,
                organizationId: liveSession.organizationId,
                organizationName: liveSession.organizationName,
            }];
        });
        setActiveSessionId(tabId);
    };

    const openSFTP = async (server, identity) => {
        initiateConnection({ server: getServerById(server), identity, type: "sftp" });
    };

    const performConnection = async (server, identity, connectionReason = null, type = null, directIdentity = null, scriptId = null, scriptName = null, tmux = null) => {
        try {
            const payload = {
                // Exactly one of the two: a stored entry, or a one-off target.
                // The server rejects both and neither.
                ...(server.id ? { entryId: server.id } : { directTarget: server.directTarget }),
                identityId: identity?.id,
                connectionReason,
                type,
                tabId: getTabId(),
                browserId: getBrowserId(),
            };

            if (directIdentity) payload.directIdentity = directIdentity;
            if (scriptId) payload.scriptId = scriptId;
            if (tmux) {
                payload.tmuxSession = tmux.name;
                payload.tmuxCreate = tmux.create;
                if (tmux.windowId) payload.tmuxWindowId = tmux.windowId;
            }
            const session = await postRequest("/connections", payload);

            const organization = server.id ? findOrganizationForServer(server.id, servers) : null;
            const organizationId = organization ? parseInt(organization.id.split("-")[1]) : null;

            const sessionData = {
                server,
                identity: identity?.id,
                id: session.sessionId,
                type: type || undefined,
                // Set here too, not just picked up from the next broadcast: without this a
                // freshly opened tab would briefly render without its discriminator, which is
                // visible flicker and can also cause it to jump between number groups once the
                // broadcast catches up.
                tmuxSession: tmux?.name || undefined,
                tmuxWindowId: tmux?.windowId || undefined,
                organizationId: organizationId,
                organizationName: organization?.name || null,
                scriptId: scriptId || undefined,
                scriptName: scriptName || undefined,
            };

            setActiveSessions(prevSessions => [...prevSessions, sessionData]);
            setActiveSessionId(session.sessionId);
            return true;
        } catch (error) {
            console.error("Failed to create session", error);
            const message = t('servers.connectionFailed', { message: error?.message || t('servers.unknownError') });
            sendToast("Error", message);
            // The real message, not a fixed one: this path covers 403, 400 and
            // 500 from POST /connections. It does NOT cover a rejected SSH
            // login -- the server answers 201 with a sessionId before the login
            // is attempted, and the failure reaches the session tab instead.
            return { error: message };
        }
    };

    // Only for a plain terminal on an SSH host with the toggle on. Scripts, SFTP
    // and file-manager terminals keep their existing path untouched. A direct
    // identity is excluded too: the picker would query (and the probe would
    // create sessions under) the entry's stored identity instead of the one
    // actually being connected with. `server` objects here come from the flattened
    // list payload (GET /api/entries/list), which has no nested `config` object,
    // so the flag must be read from the top level.
    const shouldOfferTmux = (options) =>
        Boolean(options.server?.tmuxEnabled)
        && !options.scriptId
        && !options.type
        && !options.directIdentity;

    const initiateConnection = (options) => {
        if (!options.server) return;

        const requiresReason = checkConnectionReasonRequired(options.server.id, servers);
        if (requiresReason) {
            setPendingConnection(options);
            setConnectionReasonDialogOpen(true);
            return;
        }

        if (shouldOfferTmux(options)) {
            openTmuxDialog({ ...options, connectionReason: null });
            return;
        }

        return performConnection(
            options.server,
            options.identity ?? null,
            null,
            options.type ?? null,
            options.directIdentity ?? null,
            options.scriptId ?? null,
            options.scriptName ?? null,
        );
    };

    const runScript = async (serverId, identityId, scriptId) => {
        const server = getServerById(serverId);
        if (!server) {
            console.error("Server not found");
            return;
        }

        initiateConnection({ server, identity: { id: identityId }, scriptId });
    };

    const resumeConnection = async (sessionId) => {
        try {
            await postRequest(`/connections/${sessionId}/resume`, {
                tabId: getTabId(),
                browserId: getBrowserId(),
            });
            setActiveSessionId(sessionId);
        } catch (error) {
            console.error("Failed to resume session", error);
        }
    };

    const handleConnectionReasonProvided = (reason) => {
        if (pendingConnection) {
            if (shouldOfferTmux(pendingConnection)) {
                openTmuxDialog({ ...pendingConnection, connectionReason: reason });
                setPendingConnection(null);
                setConnectionReasonDialogOpen(false);
                return;
            }

            void performConnection(
                pendingConnection.server,
                pendingConnection.identity ?? null,
                reason,
                pendingConnection.type ?? null,
                pendingConnection.directIdentity ?? null,
                pendingConnection.scriptId ?? null,
                pendingConnection.scriptName ?? null,
            );
            setPendingConnection(null);
        }
        setConnectionReasonDialogOpen(false);
    };

    const handleConnectionReasonCanceled = () => {
        setPendingConnection(null);
        setConnectionReasonDialogOpen(false);
    };

    /**
     * The only way in. Bumping the key here rather than at each call site means
     * a future third entry point cannot forget it.
     */
    const openTmuxDialog = (pending) => {
        setPendingTmuxConnection(pending);
        setTmuxDialogKey((key) => key + 1);
        setTmuxDialogOpen(true);
    };

    const finishTmuxConnection = (tmux) => {
        const pending = pendingTmuxConnection;
        setPendingTmuxConnection(null);
        setTmuxDialogOpen(false);
        if (!pending) return;

        void performConnection(
            pending.server,
            pending.identity ?? null,
            pending.connectionReason ?? null,
            pending.type ?? null,
            pending.directIdentity ?? null,
            pending.scriptId ?? null,
            pending.scriptName ?? null,
            tmux,
        );
    };

    const handleTmuxSelected = (name, create, windowId = null) => finishTmuxConnection({ name, create, windowId });
    const handleTmuxRaw = () => finishTmuxConnection(null);

    const handleTmuxCanceled = () => {
        setPendingTmuxConnection(null);
        setTmuxDialogOpen(false);
    };

    const disconnectFromServer = useCallback((sessionId) => {
        erroredSessionsRef.current.delete(sessionId);
        setActiveSessions(prev => {
            const newSessions = prev.filter(session => session.id !== sessionId);
            setActiveSessionId(currentActiveId => {
                if (newSessions.length === 0) return null;
                if (sessionId === currentActiveId) return newSessions.at(-1)?.id || null;
                return currentActiveId;
            });
            return newSessions;
        });
    }, [setActiveSessions, setActiveSessionId]);

    const closeSession = (sessionId) => {
        const session = activeSessions.find(s => s.id === sessionId);
        if (!isLocalSession(session) && !session?.isJoined) {
            closingSessionsRef.current.add(sessionId);
            deleteRequest(`/connections/${sessionId}`).catch(error => {
                console.debug("Session deletion request failed:", error);
            });
        }
        disconnectFromServer(sessionId);
    };

    const openNotes = (serverId) => {
        const server = getServerById(serverId);
        if (!server) return;

        const notesId = `notes-${serverId}`;
        const existing = activeSessions.find(s => s.id === notesId);
        if (existing) {
            setActiveSessionId(notesId);
            return;
        }

        const organization = findOrganizationForServer(server.id, servers);
        const organizationId = organization ? parseInt(organization.id.split("-")[1]) : null;

        const sessionData = {
            server,
            id: notesId,
            type: "notes",
            organizationId,
            organizationName: organization?.name || null,
        };

        setActiveSessions(prev => [...prev, sessionData]);
        setActiveSessionId(notesId);
    };

    // No POST /connections and no session on the server: the connection id IS the identity. That
    // is also why opening the same account twice lands on the tab that is already open, the same
    // way two clicks on one server are not meant to produce two sessions.
    const openOneDrive = (connection) => {
        if (!connection || connection.status !== "connected") return;

        const sessionId = `onedrive-${connection.id}`;
        if (activeSessions.some(s => s.id === sessionId)) {
            setActiveSessionId(sessionId);
            return;
        }

        setActiveSessions(prev => [...prev, {
            id: sessionId,
            type: "onedrive",
            oneDrive: {
                connectionId: connection.id,
                displayName: connection.displayName,
                microsoftEmail: connection.microsoftEmail,
            },
        }]);
        setActiveSessionId(sessionId);
    };

    const hibernateSession = async (sessionId) => {
        try {
            await postRequest(`/connections/${sessionId}/hibernate`);

            if (sessionId === activeSessionId) {
                const otherSessions = activeSessions.filter(s => s.id !== sessionId);
                setActiveSessionId(otherSessions.at(-1)?.id || null);
            }
        } catch (error) {
            console.error("Failed to hibernate session", error);
        }
    };

    const duplicateSession = async (sessionId) => {
        try {
            const result = await postRequest(`/connections/${sessionId}/duplicate`, {
                tabId: getTabId(),
                browserId: getBrowserId(),
            });

            if (result?.sessionId) {
                const originalSession = activeSessions.find(s => s.id === sessionId);
                if (originalSession) {
                    const sessionData = {
                        ...originalSession,
                        id: result.sessionId,
                        shareId: null,
                        shareWritable: false,
                    };
                    setActiveSessions(prevSessions => [...prevSessions, sessionData]);
                    setActiveSessionId(result.sessionId);
                }
            }
        } catch (error) {
            console.error("Failed to duplicate session", error);
        }
    };

    const openTerminalFromFileManager = async (sessionId, path) => {
        try {
            const originalSession = activeSessions.find(s => s.id === sessionId);
            if (!originalSession) {
                console.error("Original session not found");
                return;
            }
            if (!originalSession.server) return; // OneDrive sessions have no server to open a terminal on.

            const payload = {
                entryId: originalSession.server.id,
                identityId: originalSession.identity,
                type: "terminal",
                startPath: path,
                tabId: getTabId(),
                browserId: getBrowserId(),
            };

            const session = await postRequest("/connections", payload);

            const sessionData = {
                server: { ...originalSession.server, renderer: "terminal" },
                identity: originalSession.identity,
                id: session.sessionId,
                type: "terminal",
                organizationId: originalSession.organizationId,
                organizationName: originalSession.organizationName,
            };

            setActiveSessions(prevSessions => [...prevSessions, sessionData]);
            setActiveSessionId(session.sessionId);
        } catch (error) {
            console.error("Failed to open terminal from file manager", error);
        }
    };

    const closeDialog = () => {
        setServerDialogOpen(false);
        setServerDialogProtocol(null);
        setCurrentFolderId(null);
        setEditServerId(null);
    };

    const closePVEDialog = () => {
        setProxmoxDialogOpen(false);
        setCurrentFolderId(null);
        setEditServerId(null);
    };

    const closeSSHConfigImportDialog = () => {
        setSSHConfigImportDialogOpen(false);
        setCurrentFolderId(null);
    };

    // Called with an entry (it has no stored identity) or without one (a one-off
    // connection to a freely entered host, gated on connect.direct server side).
    const openDirectConnect = (server = null) => {
        if (server && !requiresIdentity(server)) {
            initiateConnection({ server });
            return;
        }

        setDirectConnectServer(server);
        setDirectConnectDialogOpen(true);
    };

    const openPortForward = async (server) => {
        if (!isTauri()) return;
        try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("open_tunnel_window", { 
                entryId: server.id,
                entryName: server.name 
            });
        } catch (error) {
            console.error("Failed to open port forward window", error);
        }
    };

    // Ctrl+K opens a one-off connection from anywhere on the page, as the
    // manifest declares. Skipped while typing so it cannot steal the shortcut
    // from an input, and while a session has focus the terminal keeps its keys.
    useEffect(() => {
        const onKeyDown = (event) => {
            if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
            if (event.key !== "k" && event.key !== "K") return;
            const tag = event.target?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable) return;
            event.preventDefault();
            openDirectConnect();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    });

    const closeDirectConnectDialog = () => {
        setDirectConnectDialogOpen(false);
        setDirectConnectServer(null);
    };

    // Returns whether the connection came up, so the dialog can keep itself open
    // and show "Anmeldung abgelehnt." instead of vanishing on a failed login.
    // undefined means the attempt was handed to another dialog (connection
    // reason, tmux picker) -- that counts as done here, not as a failure.
    const handleDirectConnect = (directIdentity, directTarget) =>
        initiateConnection({
            // Without a stored entry the dialog supplies the target, and this
            // stands in for the entry everywhere the tab needs a name.
            server: directConnectServer ?? {
                id: null,
                name: `${directTarget.host}:${directTarget.port}`,
                directTarget,
                // Without a renderer the view falls through to "Unknown
                // renderer"; "terminal" is the value its switch knows and the
                // one a plain SSH entry carries, matching the server side.
                renderer: "terminal",
                type: "server",
                config: { ip: directTarget.host, port: directTarget.port, protocol: directTarget.protocol },
            },
            directIdentity,
        });

    useEffect(() => {
        if (!servers) return;

        const params = new URLSearchParams(location.search);
        const connectId = params.get("connectId");

        if (connectId) {
            navigate("/servers", { replace: true });

            const handleAutoConnect = async () => {
                const server = getServerById(connectId);

                if (server && canConnectWithoutPrompt(server)) {
                    initiateConnection({ server, identity: server.identities?.[0] ?? null });
                }
            };

            handleAutoConnect();
        }
    }, [servers, location.search]);

    // The map ServerTabs actually renders from: numbers come from tabNumbers (the render-phase
    // computation above, already current for this paint) rather than straight from tabIdentities,
    // since the persistence effect only writes fresh numbers into tabIdentities after this render
    // has already committed - reading tabIdentities directly here would still show the pre-number
    // frame for a newly opened, name-colliding tab. Names have no such lag (nothing computes them
    // synchronously the way assignNumbers does), so they still come straight from the store.
    const displayIdentities = {};
    for (const id of Object.keys(tabNumbers)) {
        displayIdentities[id] = { name: tabIdentities[id]?.name, number: tabNumbers[id] };
    }

    return (
        <div className="server-page">
            <ServerDialog open={serverDialogOpen} onClose={closeDialog} currentFolderId={currentFolderId}
                          currentOrganizationId={currentOrganizationId} editServerId={editServerId}
                          initialProtocol={serverDialogProtocol} />
            <ProxmoxDialog open={proxmoxDialogOpen} onClose={closePVEDialog}
                           currentFolderId={currentFolderId}
                           currentOrganizationId={currentOrganizationId}
                           editServerId={editServerId} />
            <SSHConfigImportDialog open={sshConfigImportDialogOpen} onClose={closeSSHConfigImportDialog}
                                   currentFolderId={currentFolderId}
                                   currentOrganizationId={currentOrganizationId} />
            <DirectConnectDialog
                open={directConnectDialogOpen}
                onClose={closeDirectConnectDialog}
                server={directConnectServer}
                onConnect={handleDirectConnect}
            />
            <ConnectionReasonDialog
                isOpen={connectionReasonDialogOpen}
                onClose={handleConnectionReasonCanceled}
                onConnect={handleConnectionReasonProvided}
                serverName={pendingConnection?.server?.name || "Unknown Server"}
            />
            <TmuxSessionDialog
                key={tmuxDialogKey}
                isOpen={tmuxDialogOpen}
                onClose={handleTmuxCanceled}
                onSelect={handleTmuxSelected}
                onConnectRaw={handleTmuxRaw}
                entryId={pendingTmuxConnection?.server?.id}
                identityId={pendingTmuxConnection?.identity?.id}
            />
            {leftPaneSlot && createPortal(
                <ServerList setServerDialogOpen={(protocol = null) => {
                    setServerDialogProtocol(protocol);
                    setServerDialogOpen(true);
                }}
                            connectToServer={connectToServer}
                            setProxmoxDialogOpen={() => setProxmoxDialogOpen(true)}
                            setSSHConfigImportDialogOpen={() => setSSHConfigImportDialogOpen(true)}
                            setCurrentFolderId={setCurrentFolderId} setCurrentOrganizationId={setCurrentOrganizationId}
                            setEditServerId={setEditServerId} openSFTP={openSFTP}
                            hibernatedSessions={hibernatedSessions} resumeSession={resumeConnection}
                            joinLiveSession={joinLiveSession}
                            openDirectConnect={openDirectConnect} runScript={runScript}
                            openNotes={openNotes} openOneDrive={openOneDrive}
                            openPortForward={isTauri() ? openPortForward : undefined}
                            mobileOpen={mobileServerListOpen} setMobileOpen={setMobileServerListOpen} />,
                leftPaneSlot
            )}
            {visibleSessions.length === 0 && 
                <WelcomePanel 
                    connectToServer={connectToServer} 
                    hibernatedSessions={hibernatedSessions} 
                    resumeSession={resumeConnection}
                    openSFTP={openSFTP}
                    openDirectConnect={openDirectConnect}
                    onCreateServer={() => { setServerDialogProtocol(null); setServerDialogOpen(true); }}
                    onImportSSHConfig={() => setSSHConfigImportDialogOpen(true)}
                />
            }
            {visibleSessions.length > 0 &&
                <ViewContainer activeSessions={visibleSessions} disconnectFromServer={disconnectFromServer}
                               closeSession={closeSession}
                               activeSessionId={activeSessionId} setActiveSessionId={setActiveSessionId}
                               hibernateSession={hibernateSession} duplicateSession={duplicateSession}
                               openNotes={openNotes} renameSession={renameSession}
                               markSessionErrored={markSessionErrored}
                               getSessionError={getSessionError}
                               setOpenFileEditors={setOpenFileEditors}
                               openTerminalFromFileManager={openTerminalFromFileManager}
                               tabIdentities={displayIdentities}
                               onNewSession={() => openDirectConnect()} />}
            {openFileEditors.map((editor) => (
                editor.type === "preview" ? (
                    <FilePreviewWindow
                        key={editor.id}
                        file={editor.file}
                        session={editor.session}
                        onClose={() => setOpenFileEditors(prev => prev.filter(e => e.id !== editor.id))}
                    />
                ) : (
                    <FileEditorWindow
                        key={editor.id}
                        file={editor.file}
                        session={editor.session}
                        onClose={() => setOpenFileEditors(prev => prev.filter(e => e.id !== editor.id))}
                    />
                )
            ))}
        </div>
    );
};

const LOCAL_SESSIONS_KEY = "local_sessions";

// Handlers keyed by session kind. Every kind that lives only in the browser (see
// isLocalSession in Servers.jsx) gets one entry here; toDescriptor/restoreLocalSessions
// then apply uniformly, so a future local-only session kind only has to add a handler,
// not touch the save/restore logic itself.
const KIND_HANDLERS = {
    onedrive: {
        // Only the connectionId is worth keeping: display name and email are looked up
        // fresh from the connections list on restore, so a renamed account shows correctly.
        toDescriptor: (session) => {
            const connectionId = session.oneDrive?.connectionId;
            if (connectionId === undefined || connectionId === null) return undefined;
            return { connectionId };
        },
        // A connection that was removed, or is simply not connected right now, produces no
        // tab. Reopening a broken OneDrive session would just show an error state the user
        // did nothing to trigger; the sidebar already surfaces the disconnected account.
        fromDescriptor: (descriptor, { connections }) => {
            const connection = (connections || []).find(c => c.id === descriptor.connectionId && c.status === "connected");
            if (!connection) return undefined;
            return {
                id: `onedrive-${connection.id}`,
                type: "onedrive",
                oneDrive: {
                    connectionId: connection.id,
                    displayName: connection.displayName,
                    microsoftEmail: connection.microsoftEmail,
                },
            };
        },
    },
    notes: {
        toDescriptor: (session) => {
            const serverId = session.server?.id;
            if (serverId === undefined || serverId === null) return undefined;
            return { serverId };
        },
        // Same drop-silently rule as OneDrive: a server that was deleted since the tab was
        // last open leaves nothing to take notes on.
        fromDescriptor: (descriptor, { getServerById }) => {
            const server = getServerById?.(descriptor.serverId);
            if (!server) return undefined;
            return { server, id: `notes-${server.id}`, type: "notes" };
        },
    },
};

// The stored shape is a descriptor, never the session object: it is the minimum needed
// to rebuild the tab, so stale display data (a renamed connection, an edited server) can
// never be replayed on restore. Sessions the server already tracks return undefined here,
// which is what keeps them out of localStorage entirely.
export const toLocalSessionDescriptor = (session) => {
    const handler = KIND_HANDLERS[session?.type];
    if (!handler) return undefined;
    const descriptor = handler.toDescriptor(session);
    return descriptor ? { type: session.type, ...descriptor } : undefined;
};

// The inverse: descriptors back into session objects. Anything that can't be rebuilt
// (deleted server, gone or disconnected OneDrive account, corrupted/unknown descriptor)
// is dropped rather than resurrected in a broken state.
export const restoreLocalSessions = (descriptors, context = {}) => {
    const sessions = [];
    for (const descriptor of descriptors || []) {
        const handler = KIND_HANDLERS[descriptor?.type];
        if (!handler) continue;
        const session = handler.fromDescriptor(descriptor, context);
        if (session) sessions.push(session);
    }
    return sessions;
};

export const getStoredLocalSessionDescriptors = () => {
    try {
        const stored = localStorage.getItem(LOCAL_SESSIONS_KEY);
        const parsed = stored ? JSON.parse(stored) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.warn("Failed to load local sessions from localStorage:", error);
        return [];
    }
};

export const setStoredLocalSessionDescriptors = (descriptors) => {
    try {
        localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(descriptors));
    } catch (error) {
        console.warn("Failed to save local sessions to localStorage:", error);
    }
};

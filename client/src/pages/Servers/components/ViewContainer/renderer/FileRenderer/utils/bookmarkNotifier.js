// The same in-memory pub/sub shape as moveNotifier.js, with one deliberate difference: the filter
// runs on entryId, not sessionId. Two tiles showing the same server are two separate sessions with
// different sessionIds - moveNotifier's paneAffectedByMove bails out with
// `sessionId !== sourceSessionId` and would never reach the other tile, which is precisely the
// case a bookmark change has to reach.
const listeners = new Set();

export const publishBookmarksChanged = ({ entryId }) => {
    for (const listener of listeners) listener({ entryId });
};

export const subscribeToBookmarksChanged = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

// Only the bookmark list is reloaded - the file listing is untouched. Nothing about the directory
// contents changed just because somebody pinned a folder.
export const paneAffectedByBookmarkChange = ({ entryId, changedEntryId }) =>
    entryId !== null && entryId !== undefined && entryId === changedEntryId;

// The two panes of a move live in the same browser tab and the same React tree, so telling the
// source pane its files are gone does not need a server round trip: the server answers TRANSFER_DONE
// to the destination socket only, and the destination pane already knows, from its own transfer
// record, which source session and which paths were involved. This is a plain in-memory pub/sub the
// destination calls into once the move lands, and every pane subscribes to.
const listeners = new Set();

// Fired only for a completed, non-cancelled move - never a copy, and never a cancellation. Copying
// leaves the source directory untouched, and a cancelled move may not have moved anything at all,
// so telling the source pane in either case would just be a pointless refresh at best and, worse,
// one that races the still-running transfer.
export const publishMoveCompleted = ({ sourceSessionId, paths }) => {
    for (const listener of listeners) listener({ sourceSessionId, paths });
};

// Returns the unsubscribe function itself, not an object wrapping it, so a component's effect
// cleanup is exactly `return subscribeToMoveCompleted(...)` and cannot forget to remove the right
// listener.
export const subscribeToMoveCompleted = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

const parentOf = (p) => p.substring(0, p.lastIndexOf("/")) || "/";
const withoutTrailingSlash = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

// The one place that decides whether a move notification is this pane's business. Yes only when
// both hold: the moved files came from the exact session this pane is showing, and at least one of
// them sat directly inside the directory currently listed here - a path several levels below that
// directory names a different, unrelated listing that happens to be a descendant.
export const paneAffectedByMove = ({ sessionId, directory, sourceSessionId, paths }) => {
    if (sessionId !== sourceSessionId) return false;
    if (!Array.isArray(paths) || paths.length === 0) return false;
    const here = withoutTrailingSlash(directory);
    // The path itself is normalized before its parent is taken, not after: a moved directory
    // reported with a trailing slash (e.g. "/home/user/subfolder/") would otherwise have that
    // slash read as the split point, making its own name look like the parent instead of
    // "/home/user".
    return paths.some((p) => withoutTrailingSlash(parentOf(withoutTrailingSlash(p))) === here);
};

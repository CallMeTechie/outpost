/**
 * Which sentence, if any, the picker shows in place of a session list.
 *
 * An empty list has more than one cause, and they call for different wording.
 * Deciding that here rather than inside the JSX keeps it testable without a
 * renderer - the same reason windowFormat.js sits apart from TmuxService.
 *
 * Returns null when no sentence belongs there at all.
 */
export const emptyStateKey = ({ available, reason, sessions } = {}) => {
    // Nothing about sessions can be said when tmux itself is missing - that is
    // the state itself, not an empty list. The dialog stays open on it so the
    // sentence can actually be read, with "connect without tmux" still one
    // click away.
    if (available === false) return "servers.tmuxDialog.notInstalled";

    if (Array.isArray(sessions) && sessions.length > 0) return null;

    // "No server running" is its own state: a session that was there earlier
    // is gone, rather than none ever having been started. The plain empty
    // wording ("not yet") would quietly misreport that as a fresh host.
    if (reason === "no_server") return "servers.tmuxDialog.noServer";

    return "servers.tmuxDialog.empty";
};

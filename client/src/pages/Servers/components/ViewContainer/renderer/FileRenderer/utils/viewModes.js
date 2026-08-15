// What a pane shows is a decision, and this is the only place that makes it. The components ask
// here rather than comparing strings themselves — that is what keeps a fourth view, or a column
// moving from one view to another, a change in one file.
export const VIEW_DETAILS = "details";
export const VIEW_COMPACT = "compact";
export const VIEW_GRID = "grid";

// Display order, used by the action bar and the settings page alike so the two never disagree.
export const VIEW_MODES = [VIEW_DETAILS, VIEW_COMPACT, VIEW_GRID];

// Before there were three views the detailed one was called "list", and that value sits in every
// user's stored preference. The fallback handles it: "list" is not a current mode, so any
// stored value matching the old name returns details along with unknown values.
export const normalizeViewMode = (value) => {
    return VIEW_MODES.includes(value) ? value : VIEW_DETAILS;
};

export const showsColumns = (mode) => mode === VIEW_DETAILS;

export const showsThumbnails = (mode) => mode === VIEW_GRID;

// What the single action-bar icon should switch to: the mode after the current one, wrapping
// around. Normalizes first so an unknown or missing mode still has a well-defined next step
// instead of leaving the caller with undefined.
export const nextViewMode = (mode) => {
    const index = VIEW_MODES.indexOf(normalizeViewMode(mode));
    return VIEW_MODES[(index + 1) % VIEW_MODES.length];
};

// What a pane shows is a decision, and this is the only place that makes it. The components ask
// here rather than comparing strings themselves — that is what keeps a fourth view, or a column
// moving from one view to another, a change in one file.
export const VIEW_DETAILS = "details";
export const VIEW_COMPACT = "compact";
export const VIEW_GRID = "grid";

// Display order, used by the action bar and the settings page alike so the two never disagree.
export const VIEW_MODES = [VIEW_DETAILS, VIEW_COMPACT, VIEW_GRID];

// Before there were three views the detailed one was called "list", and that value sits in every
// user's stored preference. Translating it on read costs one branch; migrating the stored value
// would have needed a write path nobody would ever exercise again.
export const normalizeViewMode = (value) => {
    if (value === "list") return VIEW_DETAILS;
    return VIEW_MODES.includes(value) ? value : VIEW_DETAILS;
};

export const showsColumns = (mode) => mode === VIEW_DETAILS;

export const showsThumbnails = (mode) => mode === VIEW_GRID;

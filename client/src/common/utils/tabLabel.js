import { sanitizeRemoteText } from "./remoteText.js";

// Matches the cap tabIdentity.js applies to a saved tab name, so every piece of remote-sourced
// text that can end up in the always-visible tab strip shares the same budget.
const DISCRIMINATOR_MAX_LENGTH = 40;

// The tooltip has room to say more than the tab strip does, so a live title - the longest of the
// remote-sourced fields - gets double the discriminator's budget.
const LIVE_TITLE_MAX_LENGTH = 80;

// Marks what a tab *is*, independent of any name. Only the types that could be mistaken for a
// plain terminal get one - an unmarked tab already reads as "terminal" by default.
const TYPE_SUFFIX = {
    sftp: " (SFTP)",
    notes: " (Notizen)",
};

// Human-readable type names for the tooltip. Resolved here rather than through i18n: this text
// is the module's own vocabulary, not something that arrived from a remote host, so it needs
// none of the raw-text handling the tooltip values below exist to avoid.
const TYPE_LABEL = {
    terminal: "Terminal",
    sftp: "SFTP",
    notes: "Notes",
    onedrive: "OneDrive",
};

// The one piece of base text every session type but OneDrive carries. OneDrive sessions carry no
// `server` object at all - only `oneDrive` - so the access must stay optional, exactly as
// ServerTabs.jsx already does at its own `server?.name`: a plain `session.server.name` would
// throw on every OneDrive tab.
const baseName = (session) => session.server?.name ?? session.oneDrive?.displayName ?? "";

// Distinguishes same-named sessions on the same server: the attached tmux session if there is
// one, otherwise the script that started the session. Both are text the remote host or a saved
// config supplied rather than text the person looking at the tab typed, so both are run through
// the shared sanitiser before they are allowed anywhere near the label.
const discriminatorFor = (session) => {
    const raw = session.tmuxSession || session.scriptName;
    if (!raw) return "";
    return sanitizeRemoteText(raw, DISCRIMINATOR_MAX_LENGTH);
};

// The text a session would show with no custom name and no number attached - the "automatic"
// label. A discriminator that sanitises down to nothing is treated as absent rather than as an
// empty string, so a name never ends up carrying a dangling " · " for a tmux window that turned
// out to have nothing displayable in it.
const automaticText = (session) => {
    const discriminator = discriminatorFor(session);
    const withDiscriminator = discriminator ? `${baseName(session)} · ${discriminator}` : baseName(session);
    return `${withDiscriminator}${TYPE_SUFFIX[session.type] ?? ""}`;
};

// Tooltip fields are {key, value} pairs, key being a translation key the caller resolves with
// t() - this module never calls t() itself. The nearest precedent in the repo, transferDetail.js,
// takes the opposite path and has the pure function accept t() directly; here that's deliberately
// avoided because i18next HTML-escapes interpolated values, and raw text from a remote host would
// need that switched off at every call site. Forgetting it once would be invisible, so the escape
// decision is pushed to a single place instead of repeated at each caller.
const field = (key, value) => (value ? { key, value } : null);

// Builds the always-visible tab text and the richer tooltip behind it from one shared rule, so
// the two can never say different things about the same tab. `identity` is whatever a caller has
// stored for this session - `{}` for none - and is read only through `name` and `number`; this
// module has no idea where those values come from or how they persist.
export const buildTabLabel = (session, identity = {}) => {
    const hasCustomName = Boolean(identity?.name);
    const auto = automaticText(session);
    // A custom name replaces the automatic base and its discriminator, but the type suffix still
    // applies: the name says what the person called it, the suffix still says what it is.
    const body = hasCustomName ? `${identity.name}${TYPE_SUFFIX[session.type] ?? ""}` : auto;
    // Type first, number last: the type says what the tab is, the number says which of several.
    // Number 1 needs no suffix - it's the common case, and marking it would be noise on every tab
    // that never had a same-named sibling.
    const text = identity?.number > 1 ? `${body} (${identity.number})` : body;

    const tooltip = [
        field("servers.tabLabel.tooltip.server", session.server?.name ?? session.oneDrive?.displayName),
        field("servers.tabLabel.tooltip.type", TYPE_LABEL[session.type] ?? session.type),
        field("servers.tabLabel.tooltip.tmuxSession",
            session.tmuxSession && sanitizeRemoteText(session.tmuxSession, DISCRIMINATOR_MAX_LENGTH)),
        // Only the window ID is available here, not a name: the server stores just the ID
        // (controllers/serverSession.js), and resolving it to a name would need an extra
        // network call per tab. "@3" satisfies "session and window", just less prettily.
        field("servers.tabLabel.tooltip.tmuxWindow", session.tmuxWindowId),
        field("servers.tabLabel.tooltip.script",
            session.scriptName && sanitizeRemoteText(session.scriptName, DISCRIMINATOR_MAX_LENGTH)),
        field("servers.tabLabel.tooltip.liveTitle",
            session.liveTitle && sanitizeRemoteText(session.liveTitle, LIVE_TITLE_MAX_LENGTH)),
        // Without this, a renamed tab's tooltip loses every hint of what it actually points at.
        hasCustomName ? field("servers.tabLabel.tooltip.automaticName", auto) : null,
    ].filter(Boolean);

    return { text, tooltip };
};

// Same text buildTabLabel would compute with no custom name - used only to decide which sessions
// compete for the same number. Deliberately ignores any stored name: assignNumbers only ever
// sees raw sessions and previously-issued numbers, never a per-tab identity.
const groupKey = (session) => automaticText(session);

// Completes a number assignment: numbers already on file are kept untouched, every session still
// missing one gets the next free number for its text. Passing the same sessions and the result
// back in changes nothing, which is what lets this run on every list change - performConnection,
// duplicateSession, openTerminalFromFileManager and joinLiveSession all create sessions, and a
// rule that has to be called at each of those spots eventually misses one without it showing.
export const assignNumbers = (sessions, storedNumbers = {}) => {
    // The highest number already on file, across every id and every text group. A session that
    // this call doesn't see - closed, or simply left out - still keeps its number reserved:
    // there is no session object left to confirm what text it belonged to, and guessing wrong
    // would risk handing that number to an unrelated tab. The result is a gap, never a collision.
    const reservedFloor = Object.values(storedNumbers).reduce((max, n) => Math.max(max, n), 0);

    const highestByGroup = new Map();
    const result = {};

    // First pass: carry forward every number that already exists, and let each one raise the
    // ceiling for its own text group so a fresh session in the same group starts above it.
    for (const session of sessions) {
        const existing = storedNumbers[session.id];
        if (existing == null) continue;

        result[session.id] = existing;
        const key = groupKey(session);
        highestByGroup.set(key, Math.max(highestByGroup.get(key) ?? 0, existing));
    }

    // Second pass: hand out the next free number to whatever is left. The gap is deliberate -
    // closing a tab must never renumber the ones that stay, so a new session always takes the
    // next free number rather than backfilling one a closed tab left behind.
    for (const session of sessions) {
        if (result[session.id] != null) continue;

        const key = groupKey(session);
        const next = Math.max(highestByGroup.get(key) ?? 0, reservedFloor) + 1;
        result[session.id] = next;
        highestByGroup.set(key, next);
    }

    return result;
};

// Whether two assignments differ - the loop brake a caller uses to decide whether an assignment
// actually needs to be persisted or re-rendered. A shallow key/value comparison is enough because
// assignNumbers never mutates a number that already exists; anything that did change is either a
// new key, a missing key, or a number that moved.
export const diffAssignments = (previous, next) => {
    const previousKeys = Object.keys(previous ?? {});
    const nextKeys = Object.keys(next ?? {});
    if (previousKeys.length !== nextKeys.length) return true;

    return nextKeys.some((key) => previous[key] !== next[key]);
};

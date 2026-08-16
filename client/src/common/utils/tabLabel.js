import { sanitizeRemoteText } from "./remoteText.js";

// Matches the cap tabIdentity.js applies to a saved tab name, so every piece of remote-sourced
// text that can end up in the always-visible tab strip shares the same budget.
const DISCRIMINATOR_MAX_LENGTH = 40;

// The tooltip has room to say more than the tab strip does, so a live title - the longest of the
// remote-sourced fields - gets double the discriminator's budget.
const LIVE_TITLE_MAX_LENGTH = 80;

// Translation keys for the tooltip's type value, not the value itself: unlike the tmux session
// name, the script name or the live title, this is the module's own vocabulary rather than text
// that arrived from a remote host, so it goes through t() like the notes suffix does - the "don't
// translate" rule for tooltip values (see the `field` helper below) is about protecting foreign
// text from i18next's interpolation escaping, and a fixed type name was never that kind of value.
const TYPE_LABEL_KEY = {
    terminal: "servers.tabLabel.type.terminal",
    sftp: "servers.tabLabel.type.sftp",
    notes: "servers.tabLabel.type.notes",
    onedrive: "servers.tabLabel.type.onedrive",
};

// The one piece of base text every session type but OneDrive carries. OneDrive sessions carry no
// `server` object at all - only `oneDrive` - so the access must stay optional, exactly as
// ServerTabs.jsx already does at its own `server?.name`: a plain `session.server.name` would
// throw on every OneDrive tab.
const baseName = (session) => session.server?.name ?? session.oneDrive?.displayName ?? "";

// Sanitizes both possible discriminator sources once per call. The visible text uses whichever
// one wins (tmux over script); the tooltip lists each independently when present. Computing both
// here and handing the result to whoever needs it means the same string is never run through
// sanitizeRemoteText twice for the same session.
const discriminatorParts = (session) => ({
    tmuxSession: session.tmuxSession ? sanitizeRemoteText(session.tmuxSession, DISCRIMINATOR_MAX_LENGTH) : "",
    scriptName: session.scriptName ? sanitizeRemoteText(session.scriptName, DISCRIMINATOR_MAX_LENGTH) : "",
});

// Joins a base and a discriminator with " · ", but only when both sides actually have something
// to say. A discriminator that sanitised down to nothing must not leave a trailing " · ", and -
// the mirror case - a session with no server and no OneDrive name (none exist today, but nothing
// stops one from turning up) must not leave a leading one either.
const combineBaseAndDiscriminator = (base, discriminator) => {
    if (base && discriminator) return `${base} · ${discriminator}`;
    return base || discriminator;
};

// The base and discriminator, joined - everything about the automatic text except the type
// suffix. Split out from the suffix because the suffix is the one part that needs `t()` (see
// buildTabLabel), and this half doesn't: it's reused by assignNumbers, which has no `t` to call.
const discriminatedBase = (session, parts) => combineBaseAndDiscriminator(baseName(session), parts.tmuxSession || parts.scriptName);

// Tooltip fields are {key, value} pairs, key being a translation key the caller resolves with
// t() - this module never calls t() on a tooltip value. The nearest precedent in the repo,
// transferDetail.js, takes the opposite path and has the pure function accept t() directly; here
// that's deliberately avoided for these values because i18next HTML-escapes interpolated values,
// and raw text from a remote host would need that switched off at every call site. Forgetting it
// once would be invisible, so the escape decision is pushed to a single place instead of repeated
// at each caller. The type suffix in the visible text is a different case - see buildTabLabel.
const field = (key, value) => (value ? { key, value } : null);

// Builds the always-visible tab text and the richer tooltip behind it from one shared rule, so
// the two can never say different things about the same tab. `identity` is whatever a caller has
// stored for this session - `{}` for none - and is read only through `name` and `number`; this
// module has no idea where those values come from or how they persist.
//
// `t` is needed for two pieces of text, and both are static labels with no interpolation, so
// neither carries the escaping concern above: the notes suffix, which mirrors ServerTabs.jsx's own
// suffix construction verbatim (SFTP's hardcoded literal included; that literal is a pre-existing
// choice and not this task's to fix), and the tooltip's type value.
export const buildTabLabel = (session, identity = {}, t) => {
    const hasCustomName = Boolean(identity?.name);
    const parts = discriminatorParts(session);
    const base = discriminatedBase(session, parts);
    const typeSuffix = session.type === "sftp" ? " (SFTP)"
        : session.type === "notes" ? ` (${t("servers.notesPanel.title")})`
            : "";
    const auto = `${base}${typeSuffix}`;
    // A custom name replaces the automatic base and its discriminator, but the type suffix still
    // applies: the name says what the person called it, the suffix still says what it is.
    const body = hasCustomName ? `${identity.name}${typeSuffix}` : auto;
    // Type first, number last: the type says what the tab is, the number says which of several.
    // Number 1 needs no suffix - it's the common case, and marking it would be noise on every tab
    // that never had a same-named sibling.
    const text = identity?.number > 1 ? `${body} (${identity.number})` : body;

    const tooltip = [
        field("servers.tabLabel.tooltip.server", baseName(session)),
        field("servers.tabLabel.tooltip.type", TYPE_LABEL_KEY[session.type] ? t(TYPE_LABEL_KEY[session.type]) : session.type),
        field("servers.tabLabel.tooltip.tmuxSession", parts.tmuxSession),
        // Only the window ID is available here, not a name: the server stores just the ID
        // (controllers/serverSession.js), and resolving it to a name would need an extra
        // network call per tab. "@3" satisfies "session and window", just less prettily.
        field("servers.tabLabel.tooltip.tmuxWindow", session.tmuxWindowId),
        field("servers.tabLabel.tooltip.script", parts.scriptName),
        field("servers.tabLabel.tooltip.liveTitle",
            session.liveTitle && sanitizeRemoteText(session.liveTitle, LIVE_TITLE_MAX_LENGTH)),
        // Without this, a renamed tab's tooltip loses every hint of what it actually points at.
        hasCustomName ? field("servers.tabLabel.tooltip.automaticName", auto) : null,
    ].filter(Boolean);

    return { text, tooltip };
};

// Which suffix bucket a session's type falls into. Not the literal suffix text - notes needs
// t() for that (see buildTabLabel) and grouping has no t() to call - just enough to keep types
// that render with the *same* (empty) suffix in the same bucket. terminal and onedrive both
// render with no suffix at all, so a terminal session and a OneDrive session with the same base
// name render identically and must compete for the same number; grouping by raw session.type
// would keep them apart instead, which is exactly the bug this bucket exists to avoid.
const suffixBucket = (session) => {
    if (session.type === "sftp") return "sftp";
    if (session.type === "notes") return "notes";
    return "other";
};

// Used only to decide which sessions compete for the same number - it needs to collide exactly
// when two sessions would render the same automatic text and stay apart otherwise, but it does
// not need to look like anything a user would see. Built from the same inputs buildTabLabel's
// body uses - a custom name if there is one, else the base and discriminator, plus the suffix
// bucket - because a custom name is part of what gets rendered too: two sessions renamed to the
// same text must share a number sequence, or both could end up unnumbered as "Backup".
const groupKey = (session, identity) => {
    const base = identity?.name || discriminatedBase(session, discriminatorParts(session));
    return `${base}|${suffixBucket(session)}`;
};

// Whether a stored value can be trusted as an already-issued number. Anything else - a missing
// entry, but just as much a hand-edited `"abc"`, `null`, `0` or a negative number - is treated as
// absent rather than carried forward: `Math.max` propagates a `NaN` through every comparison it
// touches, so a single corrupt entry would otherwise turn every number this function ever hands
// out, in every group, into `NaN` - and stay that way forever, since a carried-forward `NaN`
// would keep passing as "already assigned" on every future call.
const isAssignedNumber = (value) => Number.isInteger(value) && value > 0;

// Completes a number assignment: numbers already on file are kept untouched, every session still
// missing one gets the next free number for its text. Passing the same sessions and the result
// back in changes nothing, which is what lets this run on every list change - performConnection,
// duplicateSession, openTerminalFromFileManager and joinLiveSession all create sessions, and a
// rule that has to be called at each of those spots eventually misses one without it showing.
//
// `identities` is keyed by session id, each entry `{ name?, number? }` - the same shape
// buildTabLabel's `identity` argument has, because the group key needs to know about a custom
// name too: renaming two sessions to the same text has to be numbered exactly like two sessions
// that already shared a base name.
export const assignNumbers = (sessions, identities = {}) => {
    // The highest number already on file, across every id and every group, ignoring any entry
    // that fails isAssignedNumber so a single corrupt one can't poison every group's floor. A
    // session that this call doesn't see - closed, or simply left out - still keeps its number
    // reserved: there is no session object left to confirm what group it belonged to, and
    // guessing wrong would risk handing that number to an unrelated tab. The result is a gap,
    // never a collision.
    const reservedFloor = Object.values(identities)
        .map((identity) => identity?.number)
        .filter(isAssignedNumber)
        .reduce((max, n) => Math.max(max, n), 0);

    const highestByGroup = new Map();
    const result = {};

    // First pass: carry forward every number that already exists and passes isAssignedNumber, and
    // let each one raise the ceiling for its own group so a fresh session in the same group
    // starts above it. A stored value that fails the check is treated the same as a missing one -
    // it falls through to the third pass and gets a fresh number instead of being trusted.
    for (const session of sessions) {
        const existing = identities[session.id]?.number;
        if (!isAssignedNumber(existing)) continue;

        result[session.id] = existing;
        const key = groupKey(session, identities[session.id]);
        highestByGroup.set(key, Math.max(highestByGroup.get(key) ?? 0, existing));
    }

    // Second pass: because the group key depends on identity.name, a rename can merge two groups
    // that were each internally consistent on their own - two tabs that both happened to be
    // "number 1" in their own, previously separate groups, invisible until now because 1 shows no
    // suffix. The first pass just carried both numbers forward blindly, so the same number can
    // now appear twice within one (recomputed) group. Resolve that by list order - the tab strip's
    // order, which is stable - rather than by any property of the session itself: whichever
    // session comes first keeps the number, because a tab that was already sitting there should
    // not move just because a later one changed. The loser is evicted back out of `result` so the
    // third pass gives it a fresh number.
    const claimedByGroup = new Map();
    for (const session of sessions) {
        if (result[session.id] == null) continue;

        const key = groupKey(session, identities[session.id]);
        const claimed = claimedByGroup.get(key) ?? new Set();
        if (claimed.has(result[session.id])) {
            delete result[session.id];
        } else {
            claimed.add(result[session.id]);
            claimedByGroup.set(key, claimed);
        }
    }

    // Third pass: hand out the next free number to whatever is left - anything that never had a
    // stored number, plus anything the second pass just evicted. The gap is deliberate - closing
    // a tab must never renumber the ones that stay, so a new session always takes the next free
    // number rather than backfilling one a closed tab (or a losing rename) left behind.
    for (const session of sessions) {
        if (result[session.id] != null) continue;

        const key = groupKey(session, identities[session.id]);
        const next = Math.max(highestByGroup.get(key) ?? 0, reservedFloor) + 1;
        result[session.id] = next;
        highestByGroup.set(key, next);
    }

    return result;
};

// Whether two assignments differ - the loop brake a caller uses to decide whether an assignment
// actually needs to be persisted or re-rendered. A shallow key/value comparison is enough because
// assignNumbers never mutates a number that already exists; anything that did change is either a
// new key, a missing key, or a number that moved. This relies on assignNumbers never producing a
// `NaN` (isAssignedNumber above is what guarantees that) - `NaN !== NaN` is always true, which
// would otherwise report a difference on every single call regardless of whether anything changed.
export const diffAssignments = (previous, next) => {
    const previousKeys = Object.keys(previous ?? {});
    const nextKeys = Object.keys(next ?? {});
    if (previousKeys.length !== nextKeys.length) return true;

    return nextKeys.some((key) => previous[key] !== next[key]);
};

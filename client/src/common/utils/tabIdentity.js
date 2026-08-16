const TAB_IDENTITIES_KEY = "tab_identities";

// Plenty for anyone who actually names tabs, small enough that the store can't grow unnoticed
// in a browser session left open for weeks.
export const TAB_IDENTITY_CAP = 200;

// C0/C1 control characters plus the bidi formatting characters (embeddings, overrides,
// isolates, marks). A custom name usually arrives pasted rather than typed - out of a ticket,
// a chat message - so "self-chosen" is no guarantee it is free of characters that could make
// the visible tab read differently from what it contains.
const CONTROL_AND_BIDI_CHARS = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

const MAX_NAME_LENGTH = 40;

// Pure decision: which entries should go when the store is over its cap. Nothing here touches
// storage, so it can be tested without a localStorage shim.
//
// protectedIds missing or not an array means "nothing is known" rather than "nothing is open" -
// the same caution as canPersistLocalSessions, just pointed the other way. There it means "don't
// write yet"; here it means "don't delete yet", because treating an unknown session list as
// empty would make every entry a candidate and could evict a tab that is still open.
export const selectEvictions = (entries, protectedIds, cap) => {
    if (!Array.isArray(protectedIds)) return [];

    const protectedSet = new Set(protectedIds);
    const ids = Object.keys(entries || {});
    const excess = ids.length - cap;
    if (excess <= 0) return [];

    const candidates = ids.filter((id) => !protectedSet.has(id))
        .sort((a, b) => entries[a].usedAt - entries[b].usedAt);

    return candidates.slice(0, excess);
};

// Trims, strips control/bidi characters and caps the length. Lives here rather than in the
// naming dialog for the same reason selectEvictions does: a named rule belongs under test, not
// buried in a component. This duplicates what a later shared sanitiser (remoteText.js /
// tabLabel.js, not built yet) will also need - once that lands, this should call it instead of
// stripping characters on its own.
export const normalizeTabName = (value) => {
    if (typeof value !== "string") return undefined;

    const cleaned = value.replace(CONTROL_AND_BIDI_CHARS, "").trim();
    if (cleaned === "") return undefined;

    return cleaned.slice(0, MAX_NAME_LENGTH);
};

export const getStoredTabIdentities = () => {
    try {
        const stored = localStorage.getItem(TAB_IDENTITIES_KEY);
        const parsed = stored ? JSON.parse(stored) : {};
        const entries = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};

        // An entry can also come from outside the dialog - hand-edited localStorage - so every
        // name is re-checked on the way out. Sanitizing only on write is not enough when the
        // store itself is the boundary.
        const normalized = {};
        for (const [id, entry] of Object.entries(entries)) {
            normalized[id] = { ...entry, name: normalizeTabName(entry?.name) };
        }
        return normalized;
    } catch (error) {
        console.warn("Failed to load tab identities from localStorage:", error);
        return {};
    }
};

export const setStoredTabIdentities = (entries) => {
    try {
        // Two windows of the same app share this key. Re-reading right before the write and
        // merging on top of it - instead of overwriting blindly - shrinks the race from "any
        // concurrent session change" down to "two writes in the same millisecond", which is
        // the best a key without a lock can do. Closing that window fully is out of scope here.
        const current = getStoredTabIdentities();
        const merged = { ...current, ...entries };
        localStorage.setItem(TAB_IDENTITIES_KEY, JSON.stringify(merged));
    } catch (error) {
        console.warn("Failed to save tab identities to localStorage:", error);
    }
};

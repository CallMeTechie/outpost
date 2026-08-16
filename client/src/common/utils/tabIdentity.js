import { sanitizeRemoteText } from "./remoteText.js";

const TAB_IDENTITIES_KEY = "tab_identities";

// Plenty for anyone who actually names tabs, small enough that the store can't grow unnoticed
// in a browser session left open for weeks.
export const TAB_IDENTITY_CAP = 200;

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

// Trims, strips control/format characters and caps the length. Lives here rather than in the
// naming dialog for the same reason selectEvictions does: a named rule belongs under test, not
// buried in a component. Stripping is delegated to the shared sanitiser (remoteText.js) so this
// repo has one answer for "what characters can a name from outside carry", not two. The trim
// and the 40-character cap stay local: they are specific to a tab name, not to remote text in
// general.
export const normalizeTabName = (value) => {
    if (typeof value !== "string") return undefined;

    // No length cap here - stripping must run over the full string before the tab-specific
    // cap below is applied, otherwise the cap could land mid-strip and change the result.
    const cleaned = sanitizeRemoteText(value, Infinity).trim();
    if (cleaned === "") return undefined;

    return cleaned.slice(0, MAX_NAME_LENGTH);
};

// A stored number must be a positive integer - assignNumbers (tabLabel.js) treats anything else
// as unassigned and hands out a fresh one. That check only ever sees what this function lets
// through: a corrupt entry that slipped past here (a hand-edited "abc", a null, a 0) would sit in
// storedNumbers and, through Math.max, turn every number a later assignNumbers call hands out -
// in every group - into NaN. Re-checked on every read for the same reason normalizeTabName is:
// an entry can come from hand-edited localStorage, not just this module's own writes.
export const normalizeTabNumber = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);

// A stored usedAt must be a finite number - selectEvictions subtracts it directly to order
// eviction candidates, and a missing or non-numeric value would turn that subtraction into NaN,
// leaving that entry's position in the sort undefined. 0 is the safe fallback: it sorts as
// "oldest", but an entry whose session is still open is protected from eviction by id regardless
// of where it lands in that order, so treating an unreadable timestamp as ancient can only ever
// make a closed entry's turn come sooner, never cost an open one its name or number.
export const normalizeTabUsedAt = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// The group a stored number was issued in (tabGroupKey in tabLabel.js), kept so that a session
// which is no longer in the list can still reserve its number inside its own group instead of
// against every group at once. Only a string can be one: assignNumbers looks it up in a Map keyed
// by group key, so anything else could only ever form a bucket of its own that no real session
// matches - dropping it here says that plainly rather than leaving a dead entry in the map.
export const normalizeTabGroup = (value) => (typeof value === "string" && value !== "" ? value : undefined);

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
            normalized[id] = {
                ...entry,
                name: normalizeTabName(entry?.name),
                number: normalizeTabNumber(entry?.number),
                group: normalizeTabGroup(entry?.group),
                usedAt: normalizeTabUsedAt(entry?.usedAt),
            };
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

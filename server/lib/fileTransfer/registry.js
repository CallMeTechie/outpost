// Process-wide, deliberately not per socket: a transfer with source S and destination D lives on
// D's socket, another with source S and destination E on E's socket. From E's socket the first one
// is invisible, so a per-socket register cannot enforce the limit on S — and that limit is the only
// thing capping how many auxiliary connections a single host gets.
const MAX_CROSS_TRANSFERS = 2;

const bySession = new Map();   // sessionId -> Set<key>
const byKey = new Map();       // key -> sessionId[]

const countFor = (sessionId) => bySession.get(sessionId)?.size ?? 0;

const reserve = (key, sessionIds) => {
    // Reject if this key is already registered: a key must be unique.
    // This prevents double-reservation from orphaning sessions in bySession.
    if (byKey.has(key)) return false;

    const unique = [...new Set(sessionIds)];
    if (unique.some((id) => countFor(id) >= MAX_CROSS_TRANSFERS)) return false;
    for (const id of unique) {
        if (!bySession.has(id)) bySession.set(id, new Set());
        bySession.get(id).add(key);
    }
    byKey.set(key, unique);
    return true;
};

const release = (key) => {
    for (const id of byKey.get(key) ?? []) {
        const set = bySession.get(id);
        if (!set) continue;
        set.delete(key);
        if (set.size === 0) bySession.delete(id);
    }
    byKey.delete(key);
};

const releaseSession = (sessionId) => {
    for (const key of [...(bySession.get(sessionId) ?? [])]) {
        // Every participant of this key loses its slot immediately — once one side of a transfer
        // is gone, it can no longer legitimately continue, and nobody should keep waiting on its
        // quota. `key` itself is deliberately left in `byKey` here (unlike plain release()): the
        // transfer this key belongs to is very likely still running on whichever side survives,
        // driven by its own run() promise, and will call release(key) on its own once that
        // settles (success, error, or FileTransfer's stall timeout) — this function has no way to
        // reach into that other socket's in-memory state and stop it early. If a fresh reserve()
        // were allowed to grab this exact string in the meantime, the transfer's belated
        // release(key) would tear down whatever the new reservation opened under the same name —
        // both the registry slot and, downstream, the auxiliary connection cached under this same
        // key in ConnectionService.js — instead of its own. `release(key)` only ever receives the
        // bare key, with nothing to tell an old reservation apart from a new one under the same
        // name, so the only way to make a late release harmless is to make sure nothing new can
        // move into its place before it arrives. The real release(key) call clears the tombstone
        // when it eventually comes; countFor is already 0 for everyone from the moment this runs.
        for (const id of byKey.get(key) ?? []) {
            const set = bySession.get(id);
            if (!set) continue;
            set.delete(key);
            if (set.size === 0) bySession.delete(id);
        }
    }
    bySession.delete(sessionId);
};

// Test helper: expose internal map sizes to verify cleanup.
const _getInternalState = () => ({
    sessionCount: bySession.size,
    keyCount: byKey.size,
});

module.exports = { reserve, release, releaseSession, countFor, MAX_CROSS_TRANSFERS, _getInternalState };

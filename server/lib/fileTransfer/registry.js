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
    for (const key of [...(bySession.get(sessionId) ?? [])]) release(key);
    bySession.delete(sessionId);
};

// Test helper: expose internal map sizes to verify cleanup.
const _getInternalState = () => ({
    sessionCount: bySession.size,
    keyCount: byKey.size,
});

module.exports = { reserve, release, releaseSession, countFor, MAX_CROSS_TRANSFERS, _getInternalState };

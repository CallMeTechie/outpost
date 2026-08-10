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

// Drops `key` from every one of its participants' own counts, without touching byKey itself.
// release() below is its only caller since fix round 3's Finding 1 — releaseSession no longer
// drops any participant's count but the vanished session's own (see below) — kept as its own named
// step rather than inlined, for what the name says on its own at the one call site that remains.
const dropCounts = (key) => {
    for (const id of byKey.get(key) ?? []) {
        const set = bySession.get(id);
        if (!set) continue;
        set.delete(key);
        if (set.size === 0) bySession.delete(id);
    }
};

const release = (key) => {
    dropCounts(key);
    byKey.delete(key);
};

// Fix round 3, Finding 1: does NOT drop the key's count for the surviving side, and does not
// touch `byKey` at all — it only forgets sessionId's own bookkeeping, since sessionId itself is
// gone for good (a fresh session never reuses an old id) and nothing will ever ask countFor(it)
// again. Earlier rounds freed the slot for every participant immediately, reasoning that a
// same-process stall in ConnectionService.js's getSFTPCrossTransferClient (awaiting
// EngineSftpClient#waitForReady, no timeout of its own) could otherwise strand it forever.
//
// What actually keeps that from happening is one single thing: ConnectionService.js puts an
// explicit CROSS_TRANSFER_CONNECT_TIMEOUT_MS deadline on exactly this connection attempt, so a
// reserve() on the cross-transfer path is always followed by a release() within a bounded time,
// with nothing else having to intervene. That is the guarantee this function relies on.
//
// SessionManager.js's cleanupConnection sweep over conn.auxSessionIds is a second net, not a
// second guarantee — it has holes, and they were misdescribed here before fix round 4. It only
// runs when the session has a masterConnection at all, only for CONTROL_PLANE_TYPES connections,
// and it only closes the ending session's own auxiliary sessions, never the peer's. Nor is the id
// registered "before the connection attempt": ConnectionService.js's registerAuxSession runs after
// two awaited lookups (credentials and jump hosts), so a resolution that hangs leaves no id for
// any sweep to find. Useful as a backstop, not something to lean on.
//
// With a release guaranteed, holding the slot until it actually arrives is strictly more honest
// than freeing it early: MAX_CROSS_TRANSFERS is the only cap on how many auxiliary connections a
// single host gets (see the header comment), and freeing it while those connections are still open
// lets a party cycle through session churn to hold far more than two at once — measured before
// this fix at 500 successful reservations against a cap of 2 (see the report for fix round 3).
const releaseSession = (sessionId) => {
    bySession.delete(sessionId);
};

// Test helper: expose internal map sizes to verify cleanup.
const _getInternalState = () => ({
    sessionCount: bySession.size,
    keyCount: byKey.size,
});

module.exports = { reserve, release, releaseSession, countFor, MAX_CROSS_TRANSFERS, _getInternalState };

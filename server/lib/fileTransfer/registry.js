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

// Shared by release() and releaseSession(): drops `key` from every one of its participants' own
// counts. Never touches byKey itself — the two callers disagree on whether the key should become
// reservable again, so that decision stays with them.
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

// countFor is deliberately freed for every participant immediately, before the transfer this key
// belongs to has actually ended (fix round 2, Finding 1 — measured, not assumed): every reserve()
// that succeeds is followed by either start()'s own catch branch or transfer.run()'s
// .then/.catch/.finally chain, both of which always eventually call release(key) — except for one
// gap outside this file's reach: getSFTPCrossTransferClient's connection setup
// (ConnectionService.js) awaits EngineSftpClient#waitForReady with no timeout of its own; a
// same-process stall or a silently dead socket in that narrow window (no keepalive configured
// anywhere in that path) would leave release(key) uncalled forever. Reserving-until-real-release
// would report the count honestly but could then strand a slot permanently over a single stuck
// connection attempt — worse than the alternative, which self-heals as soon as the participant's
// OTHER keys naturally clear. So the count is freed here and now; only the key string itself stays
// blocked (see below) until its own release() arrives.
const releaseSession = (sessionId) => {
    for (const key of [...(bySession.get(sessionId) ?? [])]) {
        // `key` itself is deliberately left in `byKey` here (unlike plain release()): the transfer
        // this key belongs to is very likely still running on whichever side survives, driven by
        // its own run() promise, and will call release(key) on its own once that settles (success,
        // error, or FileTransfer's stall timeout) — this function has no way to reach into that
        // other socket's in-memory state and stop it early. If a fresh reserve() were allowed to
        // grab this exact string in the meantime, the transfer's belated release(key) would tear
        // down whatever the new reservation opened under the same name — both the registry slot
        // and, downstream, the auxiliary connection cached under this same key in
        // ConnectionService.js — instead of its own. release(key) only ever receives the bare key,
        // with nothing to tell an old reservation apart from a new one under the same name, so the
        // only way to make a late release harmless is to make sure nothing new can move into its
        // place before it arrives. The real release(key) call clears the tombstone when it
        // eventually comes.
        dropCounts(key);
    }
};

// Test helper: expose internal map sizes to verify cleanup.
const _getInternalState = () => ({
    sessionCount: bySession.size,
    keyCount: byKey.size,
});

module.exports = { reserve, release, releaseSession, countFor, MAX_CROSS_TRANSFERS, _getInternalState };

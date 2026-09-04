// Short-lived tokens for the HTML preview route.
//
// Why a token of its own rather than the session token: the preview address carries its
// credential in the PATH, not the query, and that is the whole point -- a relative link inside
// the previewed page (an <img>, a stylesheet, an image referenced from inside that stylesheet)
// resolves against the path and therefore keeps the credential automatically. Nothing has to
// rewrite the HTML.
//
// The cost is that the credential ends up in places a query string also ends up in, and some it
// does not: proxy logs, the Referer header a previewed page sends when it links outward, browser
// history. A session token there would be a long-lived key to the whole account. So this is a
// separate value that expires in minutes, is bound to one session, and grants exactly one thing:
// reading files through that session, which its holder could already do.
//
// In memory on purpose -- these outlive neither a restart nor their own TTL, and a database row
// for a value with a ten-minute life is a row that has to be cleaned up forever after.

const TTL_MS = 10 * 60 * 1000;
const MAX_TOKENS = 500;

const crypto = require("crypto");

const tokens = new Map();

const prune = (now = Date.now()) => {
    for (const [token, entry] of tokens) {
        if (entry.expiresAt <= now) tokens.delete(token);
    }
};

// The oldest entries go first when the map is full. A cap matters because issuing is cheap and
// unauthenticated code paths must not be able to grow this without bound; the caller authenticates
// first, but the cap is what makes that a bug rather than a leak.
const evictIfFull = () => {
    if (tokens.size < MAX_TOKENS) return;
    const oldest = [...tokens.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) tokens.delete(oldest[0]);
};

// Returns { token, expiresAt }. Both values are needed by the caller: the client refreshes
// shortly before expiry rather than waiting for a broken image.
const issue = (sessionId, sessionToken, now = Date.now()) => {
    if (typeof sessionId !== "string" || !sessionId) return null;
    if (typeof sessionToken !== "string" || !sessionToken) return null;

    prune(now);
    evictIfFull();

    const token = crypto.randomBytes(24).toString("base64url");
    const expiresAt = now + TTL_MS;
    tokens.set(token, { sessionId, sessionToken, expiresAt });
    return { token, expiresAt };
};

// Null for an unknown or expired token. An expired one is deleted on the way out, so a repeated
// probe cannot keep a dead entry alive in the map.
const resolve = (token, now = Date.now()) => {
    if (typeof token !== "string" || !token) return null;

    const entry = tokens.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
        tokens.delete(token);
        return null;
    }
    return { sessionId: entry.sessionId, sessionToken: entry.sessionToken, expiresAt: entry.expiresAt };
};

// Called when a session ends: a preview token must not outlive the session it reads through.
// Session teardown already removes the connection, so a stale token would fail anyway -- this
// keeps it from lingering in the map until its TTL.
const revokeForSession = (sessionId) => {
    let removed = 0;
    for (const [token, entry] of tokens) {
        if (entry.sessionId === sessionId) {
            tokens.delete(token);
            removed++;
        }
    }
    return removed;
};

// Test seam only.
const _reset = () => tokens.clear();
const _size = () => tokens.size;

module.exports = { issue, resolve, revokeForSession, TTL_MS, MAX_TOKENS, _reset, _size };

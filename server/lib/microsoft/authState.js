const crypto = require("crypto");

const STATE_TTL_MS = 10 * 60 * 1000;

// A logged-in account can start a connect attempt as often as it likes. Without a cap the map
// would grow until the process restarts, so the oldest attempts of that same account give way.
const MAX_PENDING_PER_ACCOUNT = 5;

const states = new Map();

const sweepExpired = (now) => {
    for (const [key, value] of states.entries()) {
        if (now - value.createdAt > STATE_TTL_MS) states.delete(key);
    }
};

const enforceAccountCap = (accountId) => {
    // Map preserves insertion order, so the first matching keys are the oldest attempts.
    const mine = [];
    for (const [key, value] of states.entries()) {
        if (value.accountId === accountId) mine.push(key);
    }
    for (let i = 0; i <= mine.length - MAX_PENDING_PER_ACCOUNT; i += 1) states.delete(mine[i]);
};

const createState = ({ accountId, codeVerifier, nonce, scope }, now = Date.now()) => {
    sweepExpired(now);

    const state = crypto.randomBytes(32).toString("base64url");
    states.set(state, { accountId, codeVerifier, nonce, scope, createdAt: now });

    enforceAccountCap(accountId);

    return state;
};

// Deliberately two parameters. The account this connection belongs to is read from the stored
// entry and can never be supplied by the caller — the callback request carries no session, and a
// caller-supplied account would let an attacker attach their Microsoft account to a foreign user.
const consumeState = (state, now) => {
    if (now === undefined) now = Date.now();
    const entry = states.get(state);
    if (!entry) return null;

    states.delete(state);
    if (now - entry.createdAt > STATE_TTL_MS) return null;

    return { ...entry };
};

const pendingCount = () => states.size;

module.exports = { STATE_TTL_MS, MAX_PENDING_PER_ACCOUNT, createState, consumeState, pendingCount };

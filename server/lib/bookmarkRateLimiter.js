const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// Keyed on the account rather than the IP: several people behind one NAT must not throttle each
// other, and every one of these routes runs behind `authenticate` anyway. Sixty writes a minute is
// far above dragging a chip around and far below anything that grows the table on purpose. The GET
// stays unlimited - the bar reloads it on every cross-tile bookmark change.
const bookmarkWriteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    // `authenticate` runs in front of both routers, so req.user is always set; the IP branch only
    // exists so the limiter never keys on `undefined`. ipKeyGenerator folds an IPv6 address into its
    // /56 - without it express-rate-limit 8 rejects the generator at startup (ERR_ERL_KEY_GEN_IPV6)
    // and every address of a /64 would get its own bucket.
    keyGenerator: (req) => (req.user ? `acc:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`),
    message: { code: 429, message: "Too many bookmark changes. Please try again in a moment." },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = { bookmarkWriteLimiter };

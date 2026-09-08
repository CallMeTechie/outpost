const crypto = require("crypto");

// One canonical form for every path that reaches the database. The unique index on
// (accountId, entryId, pathHash) is the single source of truth for "this folder is already
// bookmarked", and it only holds if every writer and every comparison agrees on the spelling.
// POSIX semantics on purpose: these are remote paths on the server the pane is connected to,
// not paths on the machine running this process, so node's `path` module (which follows the
// host platform) must not be used here.
const normalizeBookmarkPath = (input) => {
    if (typeof input !== "string" || input.length === 0) return "/";

    const segments = [];
    for (const segment of input.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            // Climbing above the root stays at the root rather than producing a relative
            // path: a remote filesystem has no parent of "/".
            segments.pop();
            continue;
        }
        segments.push(segment);
    }

    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
};

// Hashed rather than indexed directly: a composite index over VARCHAR(1024) exceeds InnoDB's
// 3072-byte key limit under utf8mb4, and VARCHAR(255) would be shorter than the 4096 bytes the
// engine lets through (FP_MAX_PATH). Always called on an already normalized path.
const bookmarkPathHash = (normalizedPath) =>
    crypto.createHash("sha256").update(normalizedPath, "utf8").digest("hex");

module.exports = { normalizeBookmarkPath, bookmarkPathHash };

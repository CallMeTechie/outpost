// The candidates for the climb when a remembered directory no longer holds, from the inside out.
// Deliberately climbs along the path itself rather than towards the home directory: a remembered
// path need not live under the home at all, and /volume1/docker's nearest surviving ancestor is
// /volume1, not /root.
//
// Expects an already normalized path (see bookmarkPath.js) - normalization happens on write, so
// nothing here has to clean up "." or ".." segments.
const parentChain = (path, maxDepth = 32) => {
    if (typeof path !== "string" || path === "/" || path === "") return [];

    const segments = path.split("/").filter(Boolean);
    // A path deeper than the limit is not climbed one level at a time: the caller falls back to
    // the home directory instead. Every probe is a full directory listing over the wire.
    if (segments.length > maxDepth) return [];

    const candidates = [];
    for (let i = segments.length - 1; i > 0; i--) {
        candidates.push(`/${segments.slice(0, i).join("/")}`);
    }
    candidates.push("/");
    return candidates;
};

// A probe budget, not just a depth limit: every probe is a full directory listing with a 30 s
// request timeout (REQUEST_TIMEOUT in EngineSftpClient.js). The spec's 32 levels stay the outer
// bound (parentChain), the budget is the inner one - but the root is never dropped: it is the last
// link of the chain and the one candidate that almost always holds. Without this a path eight
// levels deep would fall through to the start directory even though /volume1 was readable.
const MAX_PROBES = 6;

const budgetedChain = (path) => {
    const chain = parentChain(path);
    if (chain.length <= MAX_PROBES) return chain;
    return [...chain.slice(0, MAX_PROBES - 1), "/"];
};

// A directory can exist and still not be readable - mode 0700 owned by someone else passes every
// stat and fails on the first listing. Probing with the listing itself is the only check that
// answers the question the pane actually asks.
const holds = async (probe, path) => {
    try {
        return await probe(path) === true;
    } catch (error) {
        // A dead connection is not "this directory is unreadable": every further probe would wait
        // out its own 30 s timeout against a socket the client has already been told about.
        // Rethrown so the chain stops instead of walking the rest of the tree.
        // "Request timeout" is what a closed EngineSftpClient answers with: _sendFrame drops the
        // frame silently once _closed is set (EngineSftpClient.js:459), so the request only fails
        // after its own 30 s REQUEST_TIMEOUT. It is the ONLY error a socket that died between two
        // probes produces - "Connection closed" reaches us only when it dies mid-request. Without
        // it the chain walks to its end, returns "/" without the abort flag, and the write-back
        // destroys the remembered path for good.
        if (/connection closed|request timeout|socket|ECONNRESET|EPIPE/i.test(error?.message ?? "")) throw error;
        return false;
    }
};

// The whole opening chain in one pure-ish function: everything that touches the wire arrives as
// `probe`, so a test can drive every branch without an SFTP connection.
const resolveOpeningDirectory = async ({ storedSessionPath, storedRow, probe, homePath }) => {
    // A resumed session already knows where it was. Probing here would cost a listing on every
    // reconnect for a path the pane was showing a second ago.
    if (storedSessionPath) return { path: storedSessionPath, restoredFrom: null };

    // The whole remembered-path branch is wrapped: holds() rethrows on a dead connection, and there
    // is nothing left to probe then - not even the home directory.
    if (storedRow) try {
        if (await holds(probe, storedRow)) return { path: storedRow, restoredFrom: null };

        for (const candidate of budgetedChain(storedRow)) {
            if (await holds(probe, candidate)) return { path: candidate, restoredFrom: storedRow };
        }

        // The climb found nothing - fall through to the home directory, but keep reporting what
        // the user had asked for.
        if (homePath && await holds(probe, homePath)) return { path: homePath, restoredFrom: storedRow };
        return { path: "/", restoredFrom: storedRow };
    } catch { return { path: "/", restoredFrom: storedRow, aborted: true }; }

    // First time on this server: the home directory, probed like any other candidate. A successful
    // realpath(".") says nothing about whether the directory can be listed.
    // Wrapped for the same reason as the branch above: holds() rethrows on a dead connection, and a
    // torn-down socket must not turn into "Connection failed: Request timeout" on a pane that has
    // nothing to remember in the first place.
    try {
        if (homePath && await holds(probe, homePath)) return { path: homePath, restoredFrom: null };
    } catch { return { path: "/", restoredFrom: null, aborted: true }; }
    return { path: "/", restoredFrom: null };
};

module.exports = { parentChain, resolveOpeningDirectory };

// The client half of server/lib/bookmarkPath.js. Both exist because client and server share no
// modules here, and both test suites read the same fixture so they cannot drift apart.
// The client only ever normalizes for comparison — it never computes the hash, which is the
// server's business alone.
export const normalizeBookmarkPath = (input) => {
    if (typeof input !== "string" || input.length === 0) return "/";

    const segments = [];
    for (const segment of input.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }

    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
};

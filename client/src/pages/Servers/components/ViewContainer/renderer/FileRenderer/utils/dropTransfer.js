// Every drag payload carries this. A receiver that does not recognize the value refuses the drop,
// so a pane from a newer build cannot hand a half-understood payload to an older one.
//
// This is an interop guard, NOT a security boundary: provider never reaches the server, and the
// five-stage check in server/lib/fileTransfer/transferAuth.js is what actually decides. Anyone
// wiring up a second provider must harden the server, not lean on this.
export const DRAG_PROVIDER = "sftp";

const parentOf = (p) => p.substring(0, p.lastIndexOf("/")) || "/";
const withoutTrailingSlash = (p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

const REJECT = { kind: "reject" };

// The one place that decides what a drop means. All four drop sites call it, because three of them
// used to decide slightly differently and that is exactly where silent holes appear.
export const resolveDropTarget = ({ data, sessionId, destination, excludeName, currentPath }) => {
    if (!data || typeof data !== "object" || Array.isArray(data)) return REJECT;

    // This payload came out of dataTransfer, i.e. entirely from the browser side and shapeable
    // by anything there. Every field the checks below touch gets its type validated here, up
    // front, so nothing past this point can throw on a hostile or merely malformed payload —
    // a throw would surface to the caller's empty catch as a drop that silently does nothing.
    if (!Array.isArray(data.paths) || data.paths.length === 0) return REJECT;
    if (!data.paths.every((p) => typeof p === "string" && p.length > 0)) return REJECT;
    if (data.items !== undefined && !Array.isArray(data.items)) return REJECT;
    if (typeof data.sessionId !== "string" || data.sessionId.length === 0) return REJECT;

    if (data.provider !== DRAG_PROVIDER) return REJECT;

    // Dropping a folder onto itself. Checked before the session split because it is nonsense
    // either way.
    if (excludeName && data.items?.some((d) => d?.name === excludeName)) return REJECT;

    if (data.sessionId !== sessionId) {
        return {
            kind: "transfer", paths: data.paths, destination,
            sourceSessionId: data.sessionId, provider: data.provider,
        };
    }

    // Only meaningful within one session: the same path string on a different host is a real
    // target, not a no-op.
    if (currentPath !== undefined) {
        const here = withoutTrailingSlash(currentPath);
        if (data.paths.every((p) => withoutTrailingSlash(parentOf(p)) === here)) return REJECT;
    }

    return { kind: "local", paths: data.paths, destination };
};

// Every drag payload carries a provider. A receiver that does not recognize the value refuses the
// drop, so a pane from a newer build cannot hand a half-understood payload to an older one.
//
// This is an interop guard, NOT a security boundary: neither provider nor source reaches a
// decision on the server, and the five-stage check in server/lib/fileTransfer/transferAuth.js is
// what actually decides. Anyone wiring up a third provider must harden the server, not lean on
// this.
export const DRAG_PROVIDERS = new Set(["sftp", "onedrive"]);

// The server is told where a transfer reads from as an endpoint descriptor. Its shape is
// server/lib/fileTransfer/endpoints.js — all this side needs to know is that it is an object
// naming a kind.
const isEndpoint = (e) =>
    !!e && typeof e === "object" && !Array.isArray(e) && typeof e.kind === "string" && e.kind.length > 0;

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
    if (typeof data.provider !== "string" || !DRAG_PROVIDERS.has(data.provider)) return REJECT;
    if (!isEndpoint(data.source)) return REJECT;

    // Dropping a folder onto itself. Checked before the session split because it is nonsense
    // either way.
    if (excludeName && data.items?.some((d) => d?.name === excludeName)) return REJECT;

    if (data.sessionId !== sessionId) {
        return {
            kind: "transfer", paths: data.paths, destination,
            // sourceSessionId is this browser's pane identity and stays; source is what the
            // server is told. They are not interchangeable — see the plan's table.
            sourceSessionId: data.sessionId, source: data.source, provider: data.provider,
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

// What a drop site does next. "ask" leaves the choice to the user and must not touch anything;
// "done" is the only outcome that may clear the selection; "failed" keeps it for the second
// attempt. Kept out of the hook so the three cases are reachable by a test at all — inside it they
// were three string literals nothing could see. run is called for a decided action only, and never
// more than once.
export const DROP_ASK = "ask";
export const DROP_DONE = "done";
export const DROP_FAILED = "failed";

export const resolveDropOutcome = (action, run) => {
    if (action !== "move" && action !== "copy") return DROP_ASK;
    return run() ? DROP_DONE : DROP_FAILED;
};

// Which handler a decided drop goes to, and — just as much the point — that its answer is handed
// straight back: startTransfer returns null when it refused or could not send, moveFiles and
// copyFiles pass on whether their message left the socket. Out here for the same reason as the
// two above: inside the hook, a branch that swallowed that answer and always reported success
// broke nothing a test could see.
export const runDrop = (decision, action, { startTransfer, moveFiles, copyFiles } = {}) => {
    if (decision.kind === "transfer") {
        return startTransfer?.({
            paths: decision.paths, destination: decision.destination,
            sourceSessionId: decision.sourceSessionId, source: decision.source, action,
        });
    }
    return action === "move"
        ? moveFiles?.(decision.paths, decision.destination)
        : copyFiles?.(decision.paths, decision.destination);
};

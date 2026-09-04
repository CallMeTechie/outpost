// A pane talks to exactly one of two sockets. This module is the only place that knows which; the
// file manager itself asks rather than assumes. Pure on purpose — it is the one part of the
// OneDrive pane a test can reach without a browser.
export const PROVIDER_SFTP = "sftp";
export const PROVIDER_ONEDRIVE = "onedrive";

export const paneProvider = (session) =>
    session?.type === PROVIDER_ONEDRIVE ? PROVIDER_ONEDRIVE : PROVIDER_SFTP;

// null rather than a throw: paneSocket runs inside a render, where a throw takes the whole view
// container down. A null stays inside the pane, which turns it into a message the user can read.
const connectionId = (session) => {
    const id = session?.oneDrive?.connectionId;
    return Number.isInteger(id) && id > 0 ? id : null;
};

const sessionId = (session) =>
    typeof session?.id === "string" && session.id.length > 0 ? session.id : null;

export const paneEndpoint = (session) => {
    if (paneProvider(session) === PROVIDER_ONEDRIVE) {
        const id = connectionId(session);
        return id === null ? null : { kind: PROVIDER_ONEDRIVE, connectionId: id, driveId: "me" };
    }
    const id = sessionId(session);
    return id === null ? null : { kind: PROVIDER_SFTP, sessionId: id };
};

export const paneSocket = (session, sessionToken) => {
    if (paneProvider(session) === PROVIDER_ONEDRIVE) {
        const id = connectionId(session);
        return id === null ? null : { path: "/api/ws/onedrive", params: { sessionToken, connectionId: id } };
    }
    const id = sessionId(session);
    return id === null ? null : { path: "/api/ws/sftp", params: { sessionToken, sessionId: id } };
};

// The HTTP twin of paneSocket: same two providers, same null-instead-of-throw shape, but for the
// three REST content routes instead of the WebSocket. It deliberately does not call getBaseUrl() —
// that would tie it to the browser globals ConnectionUtil.js reads, and this stays pure so a
// node:test can call it directly. Callers that need the origin prepend it themselves; callers that
// hand the result to a helper which already prepends it (RequestUtil's uploadFile/downloadRequest)
// pass it straight through.
//
// `path` is inserted verbatim, not percent-encoded here: the call sites disagree today about
// whether the path needs encodeURIComponent (thumbnail and upload do, download and preview don't),
// and reproducing that per call site — by encoding before calling, not inside this function — is
// what keeps an SFTP pane's address byte-identical to what it built before this function existed.
export const paneContentUrl = (session, sessionToken, { path, preview, thumbnail, size, multi, upload } = {}) => {
    const endpoint = paneEndpoint(session);
    if (endpoint === null) return null;

    const routeBase = endpoint.kind === PROVIDER_ONEDRIVE ? "/api/entries/onedrive" : "/api/entries/sftp";
    const suffix = multi ? "/multi" : upload ? "/upload" : "";

    let query = endpoint.kind === PROVIDER_ONEDRIVE
        ? `connectionId=${endpoint.connectionId}`
        : `sessionId=${endpoint.sessionId}`;
    // /multi takes its paths from the POST body, not the query string - every other route needs one.
    if (!multi) query += `&path=${path}`;
    query += `&sessionToken=${sessionToken}`;
    if (thumbnail) query += `&thumbnail=true&size=${size}`;
    if (preview) query += "&preview=true";

    return `${routeBase}${suffix}?${query}`;
};

// The HTML preview address. Unlike paneContentUrl above, the credential and the file path live in
// the URL PATH: a relative link inside the previewed page resolves against the path, so it lands
// back on this same route with the token still attached. That is what lets a mockup show its own
// images and stylesheets without anything rewriting its HTML.
//
// SFTP only. OneDrive serves its own content from Microsoft's addresses, where this trick has no
// meaning; a caller gets null and falls back to the plain preview.
export const panePreviewUrl = (session, previewToken, remotePath) => {
    if (paneProvider(session) !== PROVIDER_SFTP) return null;
    if (typeof previewToken !== "string" || !previewToken) return null;
    if (typeof remotePath !== "string" || !remotePath) return null;

    // Each segment is encoded on its own so a space or a hash in a directory name survives, while
    // the separators stay separators. The leading slash is dropped: it is implied by the route.
    const segments = remotePath.split("/").filter(Boolean).map(encodeURIComponent);
    return `/api/entries/sftp/preview/${encodeURIComponent(previewToken)}/${segments.join("/")}`;
};

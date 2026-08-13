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

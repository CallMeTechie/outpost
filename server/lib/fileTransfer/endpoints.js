const { TransferNotPermittedError } = require("./transferErrors");

const ENDPOINT_KINDS = new Set(["sftp", "onedrive"]);

// Only one drive is addressable in this project. The field exists so that shared libraries later
// are a new value rather than a protocol change.
const ONLY_DRIVE = "me";

const invalid = () => { throw new Error("Invalid transfer request"); };

// Rebuilt field by field rather than passed through: the descriptor arrives from a client, and
// anything it smuggles alongside the known fields would travel on into the resolver.
const parseEndpoint = (raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();

    if (!ENDPOINT_KINDS.has(raw.kind)) invalid();

    if (raw.kind === "sftp") {
        if (typeof raw.sessionId !== "string" || raw.sessionId === "") invalid();
        return { kind: "sftp", sessionId: raw.sessionId };
    }

    if (!Number.isInteger(raw.connectionId) || raw.connectionId <= 0) invalid();

    const driveId = raw.driveId ?? ONLY_DRIVE;
    if (driveId !== ONLY_DRIVE) invalid();

    return { kind: "onedrive", connectionId: raw.connectionId, driveId };
};

// The register counts per endpoint. A OneDrive connection id is a small integer and a session id is
// a uuid, so an unprefixed key could not collide today — but the register is shared, and a prefix
// costs nothing next to the day someone changes one of those two formats.
const endpointKey = (endpoint) =>
    (endpoint.kind === "onedrive" ? `onedrive:${endpoint.connectionId}` : endpoint.sessionId);

const describeEndpoint = (endpoint) => ({ ...endpoint });

const refuse = () => { throw new TransferNotPermittedError(); };

// The single question a OneDrive endpoint answers. Deliberately uniform with the SFTP chain's
// refusal: a foreign connection id must not be distinguishable from one that does not exist, or the
// id becomes a probe for other people's accounts.
const requireOwnConnection = async (deps, user, connectionId) => {
    if (!user?.id) refuse();

    const connection = await deps.loadConnection(connectionId);
    if (!connection) refuse();
    if (connection.accountId !== user.id) refuse();
    if (connection.status !== "connected") refuse();

    return connection;
};

// A OneDrive drive belongs to a person, not to an organization. The audit trail accepts null, and
// `undefined` would be read as "reduced attribute set" by the permission layer — a different thing.
const PERSONAL_SCOPE = { organizationId: null };

const sftpSide = (deps, endpoint, entry) => ({
    // The session's own, always-open client — deliberately NOT the auxiliary one used for the
    // transfer itself. FileTransfer._removePartial calls this after a write failed, which is
    // exactly when the auxiliary client may be the thing that broke; cleaning up over the same
    // broken connection would defeat the fallback.
    cleanup: async () => deps.createSftpAdapter(
        deps.getConnection(endpoint.sessionId)?.sftpClient, deps.getCapabilities(entry)),

    // The probe runs on the session's EXISTING client, before any auxiliary connection is opened —
    // the order the transfer chain has always used, and the reason a probe is a separate step from
    // acquiring the adapter.
    probe: async (path) => {
        try {
            const info = await deps.getConnection(endpoint.sessionId)?.sftpClient?.stat(path);
            return info ? { type: info.isDir ? "folder" : "file" } : null;
        } catch {
            return null;
        }
    },
    acquire: async (key, user) => {
        const client = await deps.getCrossClient(endpoint.sessionId, entry, user.id, key);
        return deps.createSftpAdapter(client, deps.getCapabilities(entry));
    },
    release: (key) => {
        try { deps.releaseCrossClient(deps.getConnection(endpoint.sessionId), key); } catch { /* never costs the other side its release */ }
    },
});

const oneDriveSide = (deps, endpoint) => ({
    probe: async (path) => {
        try {
            const info = await deps.createOneDriveAdapter({ connectionId: endpoint.connectionId }).stat(path);
            return info ? { type: info.type } : null;
        } catch {
            return null;
        }
    },
    // Nothing to open: the adapter is a value over an access token the store already holds.
    acquire: async () => deps.createOneDriveAdapter({ connectionId: endpoint.connectionId }),
    release: () => {},
    // No separate cleanup client: there is no connection that could be the broken one. FileTransfer
    // falls back to the destination adapter itself, which is the right answer here.
    cleanup: async () => null,
});

const resolveSource = async (deps, { user, endpoint, action }) => {
    if (endpoint.kind === "onedrive") {
        await requireOwnConnection(deps, user, endpoint.connectionId);
        return { scope: PERSONAL_SCOPE, entry: null, ...oneDriveSide(deps, endpoint) };
    }

    const { sourceEntry, sourceScope } = await deps.authorizeSource({
        user, sourceSessionId: endpoint.sessionId, action,
    });

    const side = sftpSide(deps, endpoint, sourceEntry);
    return { scope: sourceScope, entry: sourceEntry, ...side, acquire: (key) => side.acquire(key, user) };
};

const resolveDestination = async (deps, { user, endpoint, destEntry, onConflict, sourceIsFolder }) => {
    if (endpoint.kind === "onedrive") {
        await requireOwnConnection(deps, user, endpoint.connectionId);
        return { scope: PERSONAL_SCOPE, entry: null, ...oneDriveSide(deps, endpoint) };
    }

    const { destScope } = await deps.authorizeDestination({
        user, destSessionId: endpoint.sessionId, destEntry, onConflict, sourceIsFolder,
    });

    const side = sftpSide(deps, endpoint, destEntry);
    return { scope: destScope, entry: destEntry, ...side, acquire: (key) => side.acquire(key, user) };
};

module.exports = { ENDPOINT_KINDS, parseEndpoint, endpointKey, describeEndpoint, resolveSource, resolveDestination };

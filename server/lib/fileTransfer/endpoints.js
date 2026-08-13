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

module.exports = { ENDPOINT_KINDS, parseEndpoint, endpointKey, describeEndpoint };

const RDP_CLOSED_MESSAGES = ["disconnected.", "logged off.", "manually logged off.", "manually disconnected.", "forcibly disconnected."];
const RDP_LOGOFF_MESSAGES = ["logged off.", "manually logged off.", "forcibly disconnected."];

const STATUS_KEYS = new Map([
    [0x0209, "common.errors.connection.rdpSessionConflict"],
    [0x020A, "common.errors.connection.rdpSessionTimeout"],
    [0x020B, "common.errors.connection.rdpSessionClosed"],
]);

const FINAL_KEYS = new Set([
    "common.errors.connection.authenticationFailed",
    "common.errors.connection.permissionDenied",
    "common.errors.connection.hostKey",
    "common.errors.connection.rdpSessionConflict",
    "common.errors.connection.rdpSessionTimeout",
    "common.errors.connection.rdpSessionClosed",
    "common.errors.connection.sessionEnded",
]);

const errorKey = (msg) => {
    if (msg.includes("disconnected by other connection")) return "common.errors.connection.rdpSessionConflict";
    if (msg.includes("session time limit exceeded")) return "common.errors.connection.rdpSessionTimeout";
    if (RDP_CLOSED_MESSAGES.includes(msg)) return "common.errors.connection.rdpSessionClosed";
    if (msg === "session terminated") return "common.errors.connection.sessionEnded";
    if (msg === "connection lost") return "common.errors.connection.connectionLost";
    if (msg === "engine disconnected") return "common.errors.connection.engineDisconnected";
    if (msg.includes("host key")) return "common.errors.connection.hostKey";
    if (msg.includes("connection not available") || msg.includes("not available")) return "common.errors.connection.hostUnreachable";
    if (msg.includes("no route to host") || msg.includes("unreachable")) return "common.errors.connection.hostUnreachable";
    if (msg.includes("connection refused") || msg.includes("refused")) return "common.errors.connection.refused";
    if (msg.includes("timeout") || msg.includes("timed out")) return "common.errors.connection.timeout";
    if (msg.includes("authentication") || msg.includes("auth")) return "common.errors.connection.authenticationFailed";
    if (msg.includes("permission denied")) return "common.errors.connection.permissionDenied";
    if (msg.includes("aborted") || msg.includes("see logs")) return "common.errors.connection.hostUnreachable";
    return null;
};

const clean = (rawMessage) => String(rawMessage).replace(/^error:\s*/i, "").trim();

const toStatus = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const status = Number(value);
    return Number.isFinite(status) ? status : null;
};

export const mapConnectionError = (rawMessage, t) => {
    if (!rawMessage) return t("common.errors.connection.failed");
    const cleaned = clean(rawMessage);
    const key = errorKey(cleaned.toLowerCase());
    if (key) return t(key);
    return cleaned.replace(/\(see logs\)/gi, "").trim() || t("common.errors.connection.failed");
};

const ENDED_BY_RDP_KEYS = new Set([
    "common.errors.connection.rdpSessionConflict",
    "common.errors.connection.rdpSessionTimeout",
]);

export const classifyConnectionError = ({ message = null, code = null, statusCode = null, httpStatus = null } = {}, t) => {
    const status = toStatus(statusCode);
    const statusKey = STATUS_KEYS.get(status);
    const clientStatus = status !== null && status >= 0x0300 && status <= 0x03FF;
    const msg = message ? clean(message).toLowerCase() : null;
    const key = msg === null ? null : errorKey(msg);
    const reconnectable = !statusKey && !clientStatus
        && (msg === null || (!ENDED_BY_RDP_KEYS.has(key) && !RDP_LOGOFF_MESSAGES.includes(msg)));

    if (httpStatus === 410) return { text: t("common.errors.connection.expired"), retryable: false, reconnectable };
    if (httpStatus === 403 || httpStatus === 404) return { text: t("common.errors.connection.accessRevoked"), retryable: false, reconnectable };
    if (statusKey) return { text: t(statusKey), retryable: false, reconnectable };

    if (msg === null) {
        const unexpected = code !== null && code !== 1000 && code !== 1005;
        return {
            text: t(unexpected ? "common.errors.connection.closedUnexpectedly" : "common.errors.connection.error"),
            retryable: unexpected && !clientStatus,
            reconnectable,
        };
    }

    return {
        text: key ? t(key) : mapConnectionError(message, t),
        retryable: !clientStatus && !FINAL_KEYS.has(key),
        reconnectable,
    };
};

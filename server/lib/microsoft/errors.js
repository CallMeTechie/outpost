class MicrosoftDisconnectedError extends Error {
    constructor(message) {
        super(message);
        this.name = "MicrosoftDisconnectedError";
        this.kind = "disconnected";
    }
}

class MicrosoftTemporaryError extends Error {
    constructor(message, { retryAfter = null } = {}) {
        super(message);
        this.name = "MicrosoftTemporaryError";
        this.kind = "temporary";
        this.retryAfter = retryAfter;
    }
}

const readRetryAfter = (carrier) => {
    const raw = carrier?.headers?.get?.("retry-after");
    if (!raw) return null;

    const seconds = Number.parseInt(raw, 10);
    return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
};

// Only Microsoft's explicit rejection of the stored refresh token is final. Everything else —
// including a broken client secret, which is an administrator's problem and not the user's —
// leaves the connection in place so it recovers on its own.
const classifyTokenError = (error) => {
    const oauthError = typeof error?.error === "string" ? error.error : null;
    const carrier = error?.response ?? error?.cause ?? null;
    const status = Number.isInteger(error?.status) ? error.status
        : Number.isInteger(carrier?.status) ? carrier.status : null;
    const retryAfter = readRetryAfter(carrier);

    if (oauthError === "invalid_grant") return { kind: "final", reason: "invalid_grant", status, retryAfter: null };
    if (status === 429) return { kind: "transient", reason: "rate_limited", status, retryAfter };
    if (oauthError === "invalid_client") return { kind: "transient", reason: "invalid_client", status, retryAfter };
    if (status !== null && status >= 500) return { kind: "transient", reason: "server_error", status, retryAfter };
    if (oauthError) return { kind: "transient", reason: oauthError, status, retryAfter };

    return { kind: "transient", reason: "network_error", status, retryAfter };
};

module.exports = { MicrosoftDisconnectedError, MicrosoftTemporaryError, classifyTokenError };

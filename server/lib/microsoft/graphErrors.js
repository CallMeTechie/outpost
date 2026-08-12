class GraphError extends Error {
    constructor(message, { status = null, code = null, retryAfter = null } = {}) {
        super(message);
        this.name = "GraphError";
        this.status = status;
        this.code = code;
        this.retryAfter = retryAfter;
    }
}

// Graph reports its own machine-readable code in the body: { error: { code, message } }.
const readGraphCode = (body) => (typeof body?.error?.code === "string" ? body.error.code : null);

// The header side of the same job, and it lives here rather than in the client for the same reason
// readGraphCode does: pulling one fact out of a Graph answer is pure work and deserves its own test.
// Only a plain count of seconds counts — an HTTP-date is legal here and parseInt would silently turn
// "Wed, 21 Oct 2026 …" into 21.
const readRetryAfter = (headers) => {
    const raw = headers?.get?.("retry-after");
    if (!raw) return null;

    const seconds = Number.parseInt(raw, 10);
    return Number.isInteger(seconds) && seconds >= 0 ? seconds : null;
};

// Microsoft's own message is not shown to the user: it is English prose written for developers and
// sometimes several sentences long. What the user needs is one short sentence naming what is wrong.
const describeGraphFailure = (status, body) => {
    const code = readGraphCode(body);

    if (status === 507 || code === "quotaLimitReached") return "Your OneDrive is full";
    if (status === 403) return "OneDrive refused access to this item";
    if (status === 404) return "This item no longer exists in OneDrive";
    if (status === 409) return "An item with this name already exists in OneDrive";
    if (status === 429) return "Microsoft is throttling this account, please try again later";
    if (Number.isInteger(status) && status >= 500) return "OneDrive is temporarily unavailable";

    return `OneDrive request failed (${status})`;
};

module.exports = { GraphError, describeGraphFailure, readGraphCode, readRetryAfter };

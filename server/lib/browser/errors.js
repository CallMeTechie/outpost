class BrowserError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "BrowserError";
        this.code = code;
        this.details = details;
    }
}

const BrowserErrorCode = Object.freeze({
    UNAVAILABLE: "BROWSER_UNAVAILABLE",
    LIMIT_REACHED: "LIMIT_REACHED",
    VIA_PERSISTENT: "VIA_PERSISTENT",
    VIA_INVALID: "VIA_INVALID",
    INVALID_URL: "INVALID_URL",
    INVALID_PROFILE: "INVALID_PROFILE",
    INVALID_ARGUMENT: "INVALID_ARGUMENT",
    INVALID_KEY: "INVALID_KEY",
    UNKNOWN_SESSION: "UNKNOWN_SESSION",
    NO_SESSION: "NO_SESSION",
    AMBIGUOUS_SESSION: "AMBIGUOUS_SESSION",
    SESSION_CLOSED: "SESSION_CLOSED",
    PAUSED: "PAUSED",
    DIALOG_PENDING: "DIALOG_PENDING",
    STALE_REF: "STALE_REF",
    UNKNOWN_REF: "UNKNOWN_REF",
    NOT_VISIBLE: "NOT_VISIBLE",
    NAVIGATION_FAILED: "NAVIGATION_FAILED",
    EVALUATION_FAILED: "EVALUATION_FAILED",
    TIMEOUT: "TIMEOUT",
    INTERNAL: "INTERNAL",
});

module.exports = { BrowserError, BrowserErrorCode };

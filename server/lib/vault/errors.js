class VaultError extends Error {
    constructor(code, message = VaultErrorMessage[code], details = {}) {
        super(message);
        this.name = "VaultError";
        this.code = code;
        this.details = details;
    }
}

const VaultErrorCode = Object.freeze({
    ITEM_UNKNOWN: "vault.item_unknown",
    WRONG_TYPE: "vault.wrong_type",
    ITEM_UNREADABLE: "vault.item_unreadable",
    SESSION_TAINTED: "vault.session_tainted",
    VIA_NOT_ALLOWED: "vault.via_not_allowed",
    PERSISTENT_NOT_ALLOWED: "vault.persistent_not_allowed",
    ORIGIN_MISMATCH: "vault.origin_mismatch",
    NOT_PASSWORD_FIELD: "vault.not_password_field",
    BAD_USERNAME_FIELD: "vault.bad_username_field",
    FOCUS_LOST: "vault.focus_lost",
    EVALUATE_LOCKED: "vault.evaluate_locked",
    SCREENSHOT_LOCKED: "vault.screenshot_locked",
    INPUT_LOCKED: "vault.input_locked",
    APPROVAL_TIMEOUT: "vault.approval_timeout",
    APPROVAL_UNAVAILABLE: "vault.approval_unavailable",
    APPROVAL_PENDING: "vault.approval_pending",
    APPROVAL_BUSY: "vault.approval_busy",
    APPROVAL_DENIED: "vault.approval_denied",
    CLIENT_GONE: "vault.client_gone",
    RATE_LIMITED: "vault.rate_limited",
    NO_SECRET: "vault.no_secret",
});

const C = VaultErrorCode;
const VaultErrorMessage = Object.freeze({
    [C.ITEM_UNKNOWN]: "This vault item does not exist or is not available on this server. Call vault_list to see the items you can use here.",
    [C.WRONG_TYPE]: "This vault item is not a login; browser_fill_credential fills only login items. Call vault_list and pick an item whose usableBy lists browser_fill_credential.",
    [C.ITEM_UNREADABLE]: "This vault item cannot be decrypted, so nothing was filled. Ask the user to check the item in Outpost.",
    [C.SESSION_TAINTED]: "browser_evaluate ran in this browser context, so credentials are not filled here. Open a new session with browser_open without profile=persistent and fill there.",
    [C.VIA_NOT_ALLOWED]: "Credentials are not filled in sessions that run through a server (via), and an agent key may use via only with its own server. Open a session with browser_open without via.",
    [C.PERSISTENT_NOT_ALLOWED]: "Credentials are never filled in the persistent profile. Open a new session with browser_open without profile=persistent and fill there.",
    [C.ORIGIN_MISMATCH]: "The field is not on an origin this vault item allows; the page and every frame around the field must match one of its origins. Navigate to the item's login page (vault_list shows its origins).",
    [C.NOT_PASSWORD_FIELD]: "passwordRef does not point to a password input. Take a browser_snapshot and pass the ref of the password field.",
    [C.BAD_USERNAME_FIELD]: "usernameRef must point to a text, email or tel input on the same origin as the password field. Take a browser_snapshot and pass the right ref, or leave usernameRef out.",
    [C.FOCUS_LOST]: "The target field lost focus before anything was typed, so nothing was filled. Take a browser_snapshot and try again.",
    [C.EVALUATE_LOCKED]: "browser_evaluate is locked in this session because credentials were filled in its browser context. Use browser_snapshot and browser_click instead.",
    [C.SCREENSHOT_LOCKED]: "browser_screenshot is locked while a field filled by browser_fill_credential shows its value in plain text. Use browser_snapshot instead.",
    [C.INPUT_LOCKED]: "Selecting text and middle-click paste are locked in this session because credentials were filled in its browser context. Use browser_click and browser_type on single fields instead.",
    [C.APPROVAL_TIMEOUT]: "The user did not answer the approval request within 2 minutes, so nothing was filled. Ask the user, then try again.",
    [C.APPROVAL_UNAVAILABLE]: "No Outpost window of this account is open to approve the request. Ask the user to open Outpost, then try again.",
    [C.APPROVAL_PENDING]: "An approval request for this item is already open on this connection. Wait for the user to answer it before calling again.",
    [C.APPROVAL_BUSY]: "Too many approval requests of this caller are open. Wait for the user to answer them, then try again.",
    [C.APPROVAL_DENIED]: "The user denied the use of this vault item. Do not retry now; ask the user how to continue.",
    [C.CLIENT_GONE]: "The request ended before the approval arrived, so nothing was filled.",
    [C.RATE_LIMITED]: "Too many credential fills; wait a minute and try again.",
    [C.NO_SECRET]: "This entry has no stored password; ask the user to enter it in Outpost.",
});

module.exports = { VaultError, VaultErrorCode, VaultErrorMessage };

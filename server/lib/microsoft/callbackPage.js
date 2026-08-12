const MESSAGE_TYPE = "nexterm:microsoft";

const CALLBACK_REASONS = new Set([
    "state_invalid",
    "consent_required",
    "access_denied",
    "authorize_failed",
    "app_disabled",
    "exchange_failed",
    "no_refresh_token",
]);

const TEXT = {
    connected: "Your Microsoft account is connected. You can close this window.",
    error: "Connecting your Microsoft account failed. You can close this window and try again.",
};

// Everything that reaches the page comes from these two allow lists. The reason ultimately derives
// from Microsoft's query string, so it is matched against the set rather than escaped — an unknown
// value becomes the generic one and never appears in the output.
const renderCallbackPage = ({ status, reason } = {}) => {
    const safeStatus = status === "connected" ? "connected" : "error";
    const safeReason = safeStatus === "connected" ? null
        : CALLBACK_REASONS.has(reason) ? reason : "authorize_failed";

    const payload = JSON.stringify({ type: MESSAGE_TYPE, status: safeStatus, reason: safeReason });

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Nexterm</title></head>
<body style="font-family:sans-serif;padding:2rem;text-align:center">
<p>${TEXT[safeStatus]}</p>
<p><a href="/">Back to Nexterm</a></p>
<script>
(function () {
    var payload = ${payload};
    if (window.opener) {
        window.opener.postMessage(payload, window.location.origin);
        window.close();
    }
})();
</script>
</body>
</html>`;
};

module.exports = { MESSAGE_TYPE, CALLBACK_REASONS, renderCallbackPage };

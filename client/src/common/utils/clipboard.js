// Copying text, including from a page that is not a secure context.
//
// The Clipboard API only exists on https and on localhost. Outpost is normally reached over
// plain http at a LAN address, where `navigator.clipboard` is not a failing API but an absent
// one -- `navigator.clipboard.writeText(...)` throws a TypeError synchronously, which a
// `.catch()` on the call never sees. So its presence is checked, not caught.
//
// The fallback is the old execCommand path: a textarea placed off-screen, selected, copied,
// removed. Deprecated, and the only thing that works there.
const legacyCopy = (text) => {
    const area = document.createElement("textarea");
    area.value = text;
    // Off-screen rather than hidden: a display:none or visibility:hidden element cannot be
    // selected, and the copy silently does nothing.
    area.style.cssText = "position:fixed;left:-9999px;top:-9999px";
    area.setAttribute("readonly", "");
    document.body.appendChild(area);
    try {
        area.select();
        return document.execCommand("copy");
    } catch {
        return false;
    } finally {
        document.body.removeChild(area);
    }
};

// Resolves to whether the text actually made it into the clipboard, so a caller can tell the
// user when it did not instead of showing a success toast for nothing.
export const copyToClipboard = async (text) => {
    if (typeof text !== "string" || !text) return false;

    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Permission refused, or a browser that exposes the API but blocks it here.
            // The legacy path still tends to work, so it is worth trying.
        }
    }

    return legacyCopy(text);
};

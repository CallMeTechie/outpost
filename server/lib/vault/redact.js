const REDACTED = "••••";
const MIN_LENGTH = 4;

const lowerHex = (encoded) => encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const variantsOf = (secret) => {
    const percent = encodeURIComponent(secret);
    const form = new URLSearchParams([["", secret]]).toString().slice(1);
    // document.title and innerText collapse runs of whitespace, so the value can show up in that form too.
    return [secret, percent, lowerHex(percent), form, lowerHex(form), secret.replace(/\s+/g, " ").trim()];
};

const base64 = (text) => Buffer.from(text, "utf8").toString("base64");

// Longest first, or a variant that contains a shorter one leaves its rest behind. Variants under
// 4 characters stay: a very short token would blank arbitrary words of a response.
const usable = (variants) => [...new Set(variants)]
    .filter((variant) => typeof variant === "string" && variant.length >= MIN_LENGTH)
    .sort((x, y) => y.length - x.length);

const secretVariants = ({ token, headerValue = null, gitUsername = null }) => {
    const basic = gitUsername === null ? [] : [`${gitUsername}:${token}`, base64(`${gitUsername}:${token}`)];
    // JSON escapes: a JSON body may repeat the token with \" or \/ in it.
    const json = [JSON.stringify(token).slice(1, -1), token.replaceAll("/", "\\/")];
    return usable([token, ...variantsOf(token), ...json, headerValue, ...basic, base64(token)]);
};

const redactSecretText = (text, variants) => {
    let result = text;
    for (const variant of usable(variants)) result = result.split(variant).join(REDACTED);
    return result;
};

const withoutPartialVariant = (text, variants) => {
    let cut = 0;
    for (const variant of variants) {
        for (let length = Math.min(variant.length - 1, text.length); length > cut; length--) {
            if (text.endsWith(variant.slice(0, length))) {
                cut = length;
                break;
            }
        }
    }
    return text.slice(0, text.length - cut);
};

const truncateAndRedact = (text, limitBytes, variants) => {
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= limitBytes) return { text: redactSecretText(text, variants), truncated: false };
    // stream: true holds back a character cut in half instead of turning it into U+FFFD.
    const head = new TextDecoder().decode(bytes.subarray(0, limitBytes), { stream: true });
    return {
        text: `${redactSecretText(withoutPartialVariant(head, usable(variants)), variants)}\n[truncated after ${limitBytes} bytes]`,
        truncated: true,
    };
};

module.exports = { REDACTED, MIN_LENGTH, variantsOf, secretVariants, redactSecretText, truncateAndRedact };

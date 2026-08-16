// Strips C0/C1 controls, DEL, the full Unicode "Cf" (format) category - bidi overrides and
// isolates, zero-width joiners, the word joiner, soft hyphen, the BOM, and the language tag
// characters - plus the Unicode line/paragraph separators ("Zl"/"Zp", U+2028/U+2029). Text
// from a remote host (a tmux window name, a shell title) is not typed by the person looking
// at it, so none of these guarantees hold: a single override character can make a name render
// as something it is not, a joiner can hide inside what looks like a plain word, and U+2028/
// U+2029 can render as a line break just like "\n" does depending on surrounding white-space
// handling - the same forgery of an extra display line that "\n" is stripped to prevent.
// \p{Cf}, \p{Zl} and \p{Zp} are Unicode property escapes rather than literal characters or
// \uXXXX ranges, and need the "u" flag; both are standard since ES2018 and the toolchain here
// (Node 22, current Vite/esbuild) accepts them without a fallback.
const CONTROL_AND_FORMAT_CHARS = /[\x00-\x1F\x7F-\x9F\p{Cf}\p{Zl}\p{Zp}]/gu;

// Removes the unsafe characters first and only then cuts to length, so a run of stripped
// characters can never eat into the budget and leave a shorter visible result than the
// caller asked for.
export const sanitizeRemoteText = (value, maxLength) => {
    if (typeof value !== "string") return "";

    return value.replace(CONTROL_AND_FORMAT_CHARS, "").slice(0, maxLength);
};

// Strips C0/C1 controls, DEL, and the full Unicode "Cf" (format) category - bidi overrides
// and isolates, zero-width joiners, the word joiner, soft hyphen, the BOM, and the language
// tag characters. Text from a remote host (a tmux window name, a shell title) is not typed
// by the person looking at it, so none of these guarantees hold: a single override character
// can make a name render as something it is not, and a joiner can hide inside what looks like
// a plain word. \p{Cf} needs the "u" flag; both are standard since ES2018 and the toolchain
// here (Node 22, current Vite/esbuild) accepts them without a fallback.
const CONTROL_AND_FORMAT_CHARS = /[\x00-\x1F\x7F-\x9F\p{Cf}]/gu;

// Removes the unsafe characters first and only then cuts to length, so a run of stripped
// characters can never eat into the budget and leave a shorter visible result than the
// caller asked for.
export const sanitizeRemoteText = (value, maxLength) => {
    if (typeof value !== "string") return "";

    return value.replace(CONTROL_AND_FORMAT_CHARS, "").slice(0, maxLength);
};

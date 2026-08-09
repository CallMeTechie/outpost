const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

// The 0x1f mask only means anything where a control character actually exists:
// letters, space, and @ [ \ ] ^ _. Applied to a digit or a punctuation mark it
// produces something plausible-looking and wrong - "3" would become 0x13, which
// is Ctrl+S and freezes the output until Ctrl+Q, and "-" would become a carriage
// return and submit the line. Those keys are left alone instead.
const CTRL_MASKABLE = /[a-zA-Z @[\\\]^_]/;

const withControl = (character) => {
    // Ctrl+? is DEL, the one case the mask gets wrong rather than merely leaving
    // undefined.
    if (character === "?") return "\x7f";
    if (!CTRL_MASKABLE.test(character)) return character;
    return String.fromCharCode(character.toUpperCase().charCodeAt(0) & 0x1f);
};

/**
 * Applies latched modifiers to one chunk of terminal input.
 *
 * This runs in the data stream rather than in a keydown handler on purpose:
 * Android soft keyboards go through an IME that regularly reports keyCode 229
 * with key "Unidentified" instead of the character, which leaves a keydown
 * handler with nothing to work with. Data is the same whatever produced it.
 *
 * Returns the possibly rewritten data and whether the latch was spent. It does
 * not clear anything itself - the caller owns the latch.
 */
export const applyLatchedModifiers = (data, latch) => {
    if (!latch || (!latch.ctrl && !latch.alt && !latch.shift)) return { data, consumed: false };

    const code = data.length === 1 ? data.charCodeAt(0) : -1;
    const printable = code >= PRINTABLE_MIN && code <= PRINTABLE_MAX;

    // Everything that is not a single printable character passes through
    // untouched: escape sequences the bar itself sent, pasted text, non-ASCII.
    // The latch is spent all the same - a visible no-op beats an invisible
    // wrong action.
    if (!printable) return { data, consumed: true };

    let out = data;

    if (latch.ctrl) out = withControl(out);
    if (latch.alt) out = `\x1b${out}`;

    // shift deliberately does nothing here - the soft keyboard has its own
    // shift and already delivers the uppercase character. It only applies to
    // the bar's own keys, in sequences.js.
    return { data: out, consumed: true };
};

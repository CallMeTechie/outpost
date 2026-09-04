const ARROW_FINALS = { up: "A", down: "B", right: "C", left: "D" };

// Home and End share the arrows' CSI form and take the same modifier parameter.
const CURSOR_FINALS = { home: "H", end: "F" };

// Page keys use the numeric "tilde" form instead, where the modifier goes after
// the number: ESC [ 5 ; 2 ~ rather than ESC [ 1 ; 2 5 ~.
const TILDE_NUMBERS = { pageup: "5", pagedown: "6" };

// Characters a touch keyboard buries behind two layers. They are literals, not
// sequences: Ctrl and Alt have no meaningful encoding here and are ignored
// rather than invented, the same choice Ctrl+Tab gets below.
const LITERALS = { pipe: "|", tilde: "~", dash: "-", slash: "/" };

// The usual encoding: 1 is "no modifier", and each modifier adds its bit.
const modifierParameter = (latch) => 1 + (latch.shift ? 1 : 0) + (latch.alt ? 2 : 0) + (latch.ctrl ? 4 : 0);

/**
 * Builds the byte sequence for one of the bar's own keys, with the latched
 * modifiers already applied. Returns null for a key it does not know, so the
 * caller can stay silent rather than send something invented.
 */
export const barKeySequence = (key, latch) => {
    if (key === "escape") return "\x1b";

    // Same defensive shape as applyLatchedModifiers, so a caller that has not
    // built its latch yet gets a plain key rather than an exception.
    const held = latch || { ctrl: false, alt: false, shift: false };

    if (key === "tab") {
        // Shift wins over the others: Shift+Tab is the combination this whole
        // bar exists for, and there is no meaningful Ctrl+Shift+Tab to lose.
        if (held.shift) return "\x1b[Z";
        if (held.alt) return "\x1b\x09";
        // Ctrl is deliberately dropped here. Terminals encode Ctrl+Tab
        // inconsistently and none of the target applications read it, so an
        // invented sequence would be worse than none.
        return "\x09";
    }

    if (key in LITERALS) return LITERALS[key];

    const parameter = modifierParameter(held);

    const tilde = TILDE_NUMBERS[key];
    if (tilde) return parameter === 1 ? `\x1b[${tilde}~` : `\x1b[${tilde};${parameter}~`;

    const final = ARROW_FINALS[key] || CURSOR_FINALS[key];
    if (!final) return null;

    return parameter === 1 ? `\x1b[${final}` : `\x1b[1;${parameter}${final}`;
};

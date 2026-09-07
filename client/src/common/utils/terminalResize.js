// Two decisions that used to be one, and that is what broke.
//
// `fit()` is expensive and rewrites the terminal, so it may only run when the measured size
// actually moved -- a layout oscillating between two widths would otherwise repaint forever.
// Telling the host is a different question: it is one small message, and until the host has
// been told, the shell keeps drawing into the 80x24 it was started with, however right the
// browser looks.
//
// Folding the second into the first meant the size reached the host only in the instant the
// local size changed AND the socket happened to be open. A send skipped because the socket
// was still connecting was never retried, because from then on the local size never changed
// again. The terminal looked correct and the shell wrapped at column 80 until something --
// toggling focus mode -- forced another change.

// Whether the measured size differs from what the terminal is rendering at. Mirrors what
// fit() computes internally, so the two can never disagree.
export const shouldFit = (proposed, current) =>
    Boolean(proposed && proposed.cols && proposed.rows && current
        && (proposed.cols !== current.cols || proposed.rows !== current.rows));

// Whether the host still has to be told. `lastSent` is null when nothing has been sent yet
// or when a previous send was skipped, so the next poll picks it up.
export const shouldSendSize = (size, lastSent, socketOpen) => {
    if (!socketOpen || !size || !size.cols || !size.rows) return false;
    if (!lastSent) return true;
    return size.cols !== lastSent.cols || size.rows !== lastSent.rows;
};

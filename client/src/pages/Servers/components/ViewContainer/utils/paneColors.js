// One palette, asked by both sides. The tab strip and the grid derive their colour from the same
// index through the same call, so they cannot drift apart — which is the entire point of the
// feature: telling you which tab belongs to which pane.
export const PANE_COLORS = [
    // Six hues, each holding 3:1 against every theme ground the test below checks — that is the
    // one property this file enforces. Distinctness by eye and under a colour-blindness simulator
    // was reviewed once by hand while building this list; no test re-checks it, so treat that half
    // as unverified if this list is ever edited.
    //
    // Reused from AVATAR_COLORS (common/utils/avatar.js), not invented here: those are ten identity
    // colours already used elsewhere in this UI. Four were dropped, not six kept by preference:
    //   #314BD3 and #5B3FD9 fail 3:1 against at least one theme ground (2.62:1 and 2.69:1 on
    //     dark --terminal) — measured, not judged. #314BD3 is also --accent-color/$primary itself
    //     (see common/styles/_colors.sass), so it was already excluded before the contrast check.
    //   #C1364F (red) and #1E9E5A (green) clear 3:1 everywhere but were dropped anyway: this UI
    //     already gives red and green fixed meanings ($error, $success), and reusing either for
    //     an unrelated "which pane" signal would recreate the exact ambiguity this feature exists
    //     to remove.
    "#2A72C9", // blue
    "#A8741A", // amber
    "#8E3FD4", // violet
    "#C25218", // orange
    "#12908C", // cyan
    "#C13B94", // magenta
];

// The index is a position in gridSessions. A lookup that found nothing returns -1, and callers
// pass that straight through — so anything that is not a whole number at or above zero means
// "this session has no pane", and gets no colour rather than a guessed one.
export const paneColorFor = (index) =>
    Number.isInteger(index) && index >= 0 ? PANE_COLORS[index % PANE_COLORS.length] : null;

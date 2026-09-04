// One palette, asked by both sides. The tab strip and the grid derive their colour from the same
// index through the same call, so they cannot drift apart — which is the entire point of the
// feature: telling you which tab belongs to which pane.
export const PANE_COLORS = [
    // Six hues, each holding 3:1 against every theme ground the test below checks — that is the
    // one property this file enforces, and the only one anyone has verified. Whether the six are
    // actually distinguishable side by side, and whether they survive a colour-blindness
    // simulator, has NOT been checked: the list was assembled without a screen. Treat that half
    // as open, both now and if this list is ever edited.
    //
    // Reused from AVATAR_COLORS (common/utils/avatar.js), not invented here: those are ten identity
    // colours already used elsewhere in this UI. Four were dropped, not six kept by preference:
    //   #314BD3 and #5B3FD9 fail 3:1 against at least one theme ground (2.62:1 and 2.69:1 on
    //     dark --terminal) — measured, not judged. #314BD3 is also --accent-color/$primary itself
    //     (see common/styles/_colors.sass), so it was already excluded before the contrast check.
    //   #C1364F (red) and #1E9E5A (green) clear 3:1 everywhere and were dropped for a reason that
    //     is inference rather than record: this UI gives red and green fixed meanings ($error,
    //     $success), so reusing either for an unrelated "which pane" signal looked like it would
    //     recreate the ambiguity this feature exists to remove. No written decision confirms that
    //     was the original motive.
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

// A colour for an entry that has no pane -- the welcome screen's target cards. It is an IDENTITY
// colour, not a pane colour: derived from the entry id, so the same target keeps the same colour
// across reloads and however the recent list is ordered. A pane colour comes from a position in
// the grid and changes as panes open and close, which is exactly what a card must not do.
//
// Same palette and same hashing as getAvatarColor in common/utils/avatar.js, so the two cannot
// drift; the caveat at the top of PANE_COLORS about distinguishability applies here too.
export const entryColorFor = (entryId) => {
    const key = String(entryId ?? "");
    if (!key) return PANE_COLORS[0];

    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash << 5) - hash + key.charCodeAt(i);
        hash |= 0;
    }
    return PANE_COLORS[Math.abs(hash) % PANE_COLORS.length];
};

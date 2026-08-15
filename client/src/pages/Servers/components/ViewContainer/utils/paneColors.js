// One palette, asked by both sides. The tab strip and the grid derive their colour from the same
// index through the same call, so they cannot drift apart — which is the entire point of the
// feature: telling you which tab belongs to which pane.
export const PANE_COLORS = [
    // Six hues far enough apart to be told apart at a glance, and light enough to hold 3:1 against
    // #F5F5F5 as well as #000000. Red and green are not neighbours, and no two adjacent entries
    // differ in hue alone — see the test, which enforces the contrast half of that.
    // Reused from AVATAR_COLORS (common/utils/avatar.js), not invented here: those ten values
    // already exist as an identity colour in the UI, and six of them turned out to already clear
    // 3:1 against every ground below once measured — verifying beat guessing a fresh set.
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

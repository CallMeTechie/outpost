// The only tricky part of the favorites bar, and therefore the only part that lives outside the
// component: measured widths in, the split into visible and hidden out. No DOM, so node:test can
// drive every edge case.
//
// The row never wraps and never scrolls sideways - a growing bar would shrink the file list
// without asking. Whatever does not fit goes into the overflow menu behind the chevron.
export const splitForOverflow = ({ widths, available, gap, chevronWidth }) => {
    if (!Array.isArray(widths) || widths.length === 0) return { visible: 0, hidden: [] };

    // First question: does the whole row fit without a chevron at all?
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1);
    if (total <= available) return { visible: widths.length, hidden: [] };

    // It does not, so a chevron is needed and it costs space of its own.
    const budget = available - chevronWidth - gap;
    let used = 0;
    let visible = 0;
    for (const width of widths) {
        const next = used === 0 ? width : used + gap + width;
        if (next > budget) break;
        used = next;
        visible++;
    }

    const hidden = [];
    for (let i = visible; i < widths.length; i++) hidden.push(i);
    return { visible, hidden };
};

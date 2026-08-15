import test from "node:test";
import assert from "node:assert";
import { PANE_COLORS, paneColorFor } from "../paneColors.js";

// Every ground a pane colour is drawn on, copied from common/styles/_colors.sass: --terminal
// carries the pane border, --background carries the tab line (.server-tabs sets none of its own).
// A snapshot: if those change, this test has to be pulled along — it will not notice on its own.
const BACKGROUNDS = {
    "dark --terminal": "#13181C",
    "dark --background": "#000A12",
    "light --terminal": "#F5F5F5",
    "light --background": "#FFFFFF",
    "oled --terminal": "#000000",
    "oled --background": "#000000",
};

const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

// The unfocused split-view pane border is drawn as this fraction of the pane colour, mixed with
// the fully-transparent rest — a snapshot of ViewContainer/styles.sass:118's
// `color-mix(in srgb, var(--pane-color, transparent) 97%, transparent)`. If that number moves,
// this one has to move with it; the test below is what stops it moving down without anyone
// noticing the border quietly stopped clearing 3:1.
const FAINT_MIX = 0.97;

// Only the terminal grounds: the faint border is drawn on .session-renderer, which paints
// colors.$terminal underneath it (ViewContainer/styles.sass) — it never sits on --background,
// unlike the opaque colour above, which the tab underline also draws over --background.
const TERMINALS = {
    "dark --terminal": "#13181C",
    "light --terminal": "#F5F5F5",
    "oled --terminal": "#000000",
};

// A colour mixed toward transparent and drawn over an opaque ground composites linearly per
// channel — the same maths `color-mix(in srgb, colour X%, transparent)` performs in the browser.
const mixOverBackground = (hex, mix, backgroundHex) => {
    const channels = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [fr, fg, fb] = channels(hex);
    const [br, bg, bb] = channels(backgroundHex);
    const toHex = (v) => Math.round(v).toString(16).padStart(2, "0");
    return `#${toHex(mix * fr + (1 - mix) * br)}${toHex(mix * fg + (1 - mix) * bg)}${toHex(mix * fb + (1 - mix) * bb)}`;
};

test("there are six colours and none repeats", () => {
    assert.strictEqual(PANE_COLORS.length, 6);
    assert.strictEqual(new Set(PANE_COLORS).size, 6);
});

test("every colour is a six-digit hex value", () => {
    for (const colour of PANE_COLORS) assert.match(colour, /^#[0-9a-fA-F]{6}$/, colour);
});

test("the first six indices give the six colours in order", () => {
    PANE_COLORS.forEach((colour, index) => assert.strictEqual(paneColorFor(index), colour));
});

test("the seventh pane starts the row again", () => {
    assert.strictEqual(paneColorFor(6), PANE_COLORS[0]);
    assert.strictEqual(paneColorFor(7), PANE_COLORS[1]);
});

// A tab whose session has no grid slot must get nothing rather than a guessed colour — the
// lookup that produces this index returns -1, and -1 is not a position.
test("a session without a grid slot gets no colour", () => {
    for (const index of [-1, undefined, null, "0", 1.5, NaN, {}]) {
        assert.strictEqual(paneColorFor(index), null, String(index));
    }
});

// WCAG 1.4.11 asks for 3:1 on a non-text element like a border. The palette is chosen against
// the darkest and the lightest ground the app offers, so a pane border never washes out.
test("every colour holds 3:1 against every theme ground", () => {
    for (const colour of PANE_COLORS) {
        for (const [ground, background] of Object.entries(BACKGROUNDS)) {
            const ratio = contrast(colour, background);
            assert.ok(ratio >= 3, `${colour} on ${ground} (${background}) is only ${ratio.toFixed(2)}:1`);
        }
    }
});

// The unfocused pane border only ever draws the mixed-down colour, never the opaque one above —
// with four panes open, three of the four are in this state at any time. The palette's own worst
// case (violet on dark --terminal, 3.24:1 opaque) leaves under six points of mix between "passes
// 3:1" and "fully opaque", which is why FAINT_MIX sits as high as it does — see the comment next
// to it, and ViewContainer/styles.sass:118 for why colour alone no longer carries the
// focused/unfocused distinction.
test("the faint pane border still holds 3:1 against every terminal ground", () => {
    for (const colour of PANE_COLORS) {
        for (const [ground, background] of Object.entries(TERMINALS)) {
            const faint = mixOverBackground(colour, FAINT_MIX, background);
            const ratio = contrast(faint, background);
            assert.ok(ratio >= 3, `${colour} at ${FAINT_MIX * 100}% on ${ground} (${background}) is only ${ratio.toFixed(2)}:1`);
        }
    }
});

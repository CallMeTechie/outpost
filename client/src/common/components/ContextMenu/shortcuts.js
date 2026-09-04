// Menu accelerators, per the artboard (docs/design/mockups/ui-servers.html, `.menu .item kbd`).
//
// They are deliberately *menu* shortcuts, not page shortcuts: they fire only while the menu that
// declares them is open. A single letter bound globally would be unusable here, because most of
// this page is a terminal and every keystroke belongs to it. An open menu already owns the
// keyboard -- it moves focus to its first item and handles arrows and Escape -- so a letter costs
// nothing there and is what makes a menu operable without the mouse.
//
// One notation is used for both jobs, so a shortcut cannot display one thing and match another:
// "E", "F2", "Delete", "Ctrl+W", "Shift+Enter".

const MODIFIER_SYMBOL = { ctrl: "⌃", shift: "⇧", alt: "⌥", meta: "⌘" };

// Keys whose name is longer than the symbol everyone recognises.
const KEY_SYMBOL = {
    enter: "↵",
    delete: "⌫",
    backspace: "⌫",
    escape: "Esc",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
};

const MODIFIERS = ["ctrl", "shift", "alt", "meta"];

// Splits "Ctrl+Shift+F" into its modifiers and its one real key. Returns null for anything that
// names no key at all, so a typo degrades to "no shortcut" rather than to one that can never fire.
export const parseShortcut = (shortcut) => {
    if (typeof shortcut !== "string" || !shortcut.trim()) return null;

    const parts = shortcut.split("+").map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return null;

    const mods = new Set();
    let key = null;

    for (const part of parts) {
        const lower = part.toLowerCase();
        if (MODIFIERS.includes(lower)) {
            mods.add(lower);
        } else if (lower === "cmd" || lower === "command") {
            mods.add("meta");
        } else if (key !== null) {
            // Two non-modifier parts is not a shortcut anyone can press.
            return null;
        } else {
            key = lower;
        }
    }

    return key ? { mods, key } : null;
};

// What the menu prints. Modifiers in a fixed order so the same combination always reads the same,
// whatever order it was written in.
export const formatShortcut = (shortcut) => {
    const parsed = parseShortcut(shortcut);
    if (!parsed) return "";

    const prefix = MODIFIERS.filter((mod) => parsed.mods.has(mod)).map((mod) => MODIFIER_SYMBOL[mod]).join("");
    const key = KEY_SYMBOL[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key.replace(/^f(\d+)$/, "F$1"));
    return `${prefix}${key}`;
};

// Whether a keyboard event is this shortcut. Every modifier is compared, including the ones the
// shortcut does not ask for: without that, "E" would also fire on Ctrl+E and swallow a binding
// the browser or the terminal owns.
export const matchesShortcut = (shortcut, event) => {
    const parsed = parseShortcut(shortcut);
    if (!parsed || !event) return false;

    const pressed = { ctrl: !!event.ctrlKey, shift: !!event.shiftKey, alt: !!event.altKey, meta: !!event.metaKey };
    for (const mod of MODIFIERS) {
        if (pressed[mod] !== parsed.mods.has(mod)) return false;
    }

    // event.key carries the shifted character ("E" for shift+e), so a plain letter is compared
    // case-insensitively and a named key ("Enter", "F2", "Delete") by its lowercased name.
    return (event.key || "").toLowerCase() === parsed.key;
};

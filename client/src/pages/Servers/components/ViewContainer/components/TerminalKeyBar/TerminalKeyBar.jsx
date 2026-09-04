import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiArrowUp, mdiArrowDown, mdiArrowLeft, mdiArrowRight } from "@mdi/js";
import "./styles.sass";

// The translation keys are spelled out rather than built from the name: every
// other t() call in this codebase uses a literal, and a literal is what a future
// key extractor would be able to find.
const ARROWS = [
    { key: "left", path: mdiArrowLeft, label: "servers.keyBar.left" },
    { key: "up", path: mdiArrowUp, label: "servers.keyBar.up" },
    { key: "down", path: mdiArrowDown, label: "servers.keyBar.down" },
    { key: "right", path: mdiArrowRight, label: "servers.keyBar.right" },
];

// The artboard's third and fourth groups: navigation keys and the characters a
// touch keyboard buries two layers deep. Labels are the keycap text, so they
// need no translation; the aria-labels do.
const NAVIGATION = [
    { key: "home", label: "Home", aria: "servers.keyBar.home" },
    { key: "end", label: "End", aria: "servers.keyBar.end" },
    { key: "pageup", label: "PgUp", aria: "servers.keyBar.pageUp" },
    { key: "pagedown", label: "PgDn", aria: "servers.keyBar.pageDown" },
];

const CHARACTERS = [
    { key: "pipe", label: "|", aria: "servers.keyBar.pipe" },
    { key: "tilde", label: "~", aria: "servers.keyBar.tilde" },
    { key: "dash", label: "-", aria: "servers.keyBar.dash" },
    { key: "slash", label: "/", aria: "servers.keyBar.slash" },
];

const MODIFIERS = [
    { name: "ctrl", label: "Ctrl", aria: "servers.keyBar.ctrl" },
    { name: "alt", label: "Alt", aria: "servers.keyBar.alt" },
    { name: "shift", label: "Shift", aria: "servers.keyBar.shift" },
];

export const TerminalKeyBar = ({ latch, onToggleModifier, onSendKey, disabled = false }) => {
    const { t } = useTranslation();

    // Without this the button takes focus, the terminal loses it, and the
    // on-screen keyboard closes on every single tap.
    const keepFocus = (event) => event.preventDefault();

    return (
        <div className={`terminal-key-bar${disabled ? " disabled" : ""}`} role="toolbar"
             aria-disabled={disabled} data-ui-id="UI-SERVERS-KEYBAR">
            <button type="button" className="key" disabled={disabled} onPointerDown={keepFocus}
                    aria-label={t("servers.keyBar.escape")}
                    onClick={() => onSendKey("escape")}>Esc</button>

            <button type="button" className="key" disabled={disabled} onPointerDown={keepFocus}
                    aria-label={t("servers.keyBar.tab")}
                    onClick={() => onSendKey("tab")}>Tab</button>

            {MODIFIERS.map(({ name, label, aria }) => (
                <button key={name} type="button" disabled={disabled} onPointerDown={keepFocus}
                        className={`key modifier ${latch[name] ? "latched" : ""}`}
                        aria-label={t(aria)}
                        aria-pressed={latch[name]}
                        onClick={() => onToggleModifier(name)}>{label}</button>
            ))}

            {ARROWS.map(({ key, path, label }) => (
                <button key={key} type="button" className="key arrow" disabled={disabled} onPointerDown={keepFocus}
                        aria-label={t(label)}
                        onClick={() => onSendKey(key)}><Icon path={path} /></button>
            ))}

            {NAVIGATION.map(({ key, label, aria }) => (
                <button key={key} type="button" className="key nav" disabled={disabled} onPointerDown={keepFocus}
                        aria-label={t(aria)}
                        onClick={() => onSendKey(key)}>{label}</button>
            ))}

            {CHARACTERS.map(({ key, label, aria }) => (
                <button key={key} type="button" className="key char" disabled={disabled} onPointerDown={keepFocus}
                        aria-label={t(aria)}
                        onClick={() => onSendKey(key)}>{label}</button>
            ))}
        </div>
    );
};

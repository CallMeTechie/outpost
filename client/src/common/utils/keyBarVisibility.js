// Whether the on-screen key bar is shown.
//
// Small enough to look obvious and wrong twice already, which is why it lives here with a
// truth table instead of inline in the provider:
//
//   1. It asked `(pointer: coarse) and (hover: none)` -- what the browser considers the
//      device's primary input. A tablet answers "coarse" with a mouse plugged in, so the bar
//      appeared for someone working with mouse and keyboard.
//   2. It asked `not (any-pointer: fine)` -- whether a precise pointer exists at all. Same
//      tablet, same answer, same bar. The query was the wrong instrument, not the wrong query:
//      both ask the device about itself.
//
// So the media query is only the opening guess, and the first pointer event overrules it. An
// event carries what was actually used; nothing about the hardware has to be inferred.
//
// `mode`        -- the user's setting: "auto" | "always" | "never"
// `pointerKind` -- "mouse" | "touch" | null (nothing pointed at anything yet)
// `mediaTouchOnly` -- what the media query said, used only while pointerKind is null
export const shouldShowKeyBar = (mode, pointerKind, mediaTouchOnly) => {
    // The explicit settings win over every detection: someone who turned it off means off,
    // on a phone as much as on a desktop.
    if (mode === "always") return true;
    if (mode === "never") return false;

    // Anything else is treated as auto, including an unset or corrupted preference: the
    // fallback has to be the mode that adapts, not one that locks the bar on or off.
    if (pointerKind === "mouse") return false;
    if (pointerKind === "touch") return true;
    return !!mediaTouchOnly;
};

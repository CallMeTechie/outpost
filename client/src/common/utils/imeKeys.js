// Which keystrokes belong to the on-screen keyboard's IME rather than to the terminal.
//
// A soft keyboard (Gboard, Samsung Keyboard) types a word as a composition: the letters
// accumulate in xterm's hidden textarea and are sent as one piece when the word is done.
// Deleting a letter inside that word is part of the same composition -- except that Chrome
// on Android reports Backspace with its real key code, not the IME's 229. xterm takes that
// as "a non-composition key arrived, the composition is over", sends the word as typed so
// far, deletes one character, and stops tracking the composition. The keyboard, which was
// never told anything, keeps composing the very same word -- and every next letter sends
// the whole word once more. Delete "o" from "hello", type "p", and the terminal reads
// "hellhellp".
//
// So while a composition is open, Backspace is left to the IME. `isComposing` on the
// event is the standard signal; the tracked flag is there because it has been seen absent.
export const isImeBackspace = (event, composing) =>
    event?.type === "keydown"
    && event.key === "Backspace"
    && Boolean(event.isComposing || composing);

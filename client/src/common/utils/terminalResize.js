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

// Wie lange nach einem Einpassen der Rückweg auf die vorherige Größe als Pendeln gilt.
// Der Takt der Rückkopplung liegt bei 300 ms; wer wirklich um eine Spalte zurückzieht, wartet
// höchstens so lange, bis der nächste Takt es doch anwendet.
const BOUNCE_MS = 2000;

// Whether the measured size differs from what the terminal is rendering at. Mirrors what
// fit() computes internally, so the two can never disagree.
//
// `previous` ist die Größe, von der zuletzt weg-eingepasst wurde, mit Zeitstempel -- der
// Bremsklotz gegen einen Zwei-Takt.
//
// Gemessen am 2026-09-07 in der geteilten Ansicht: Ein Pane von konstant 938,64 px Breite
// bekam von proposeDimensions abwechselnd 104 und 105 Spalten vorgeschlagen, alle 300 ms,
// unbegrenzt. Die Breite stand still, der Vorschlag nicht. Der Grund liegt in xterm: nach
// jedem resize() wird die Zeichenbreite neu vermessen, und bei einer Pane-Breite, die genau
// auf der Grenze zwischen zwei Spaltenzahlen liegt, kippt die Nachkommastelle hin und her.
// Jedes Einpassen erzeugt so die Bedingung für das nächste -- und weil die neue Größe auch
// an die Gegenseite ging, zeichnete tmux jedes Mal neu. Das war das sichtbare Zittern.
//
// Die Bremse: Ein Vorschlag, der genau auf die zuletzt verlassene Größe zurückführt, wird
// kurzzeitig nicht angenommen. Ein echtes Verändern des Fensters liefert einen anderen Wert
// und kommt sofort durch.
export const shouldFit = (proposed, current, previous = null, now = 0) => {
    if (!proposed || !proposed.cols || !proposed.rows || !current) return false;
    if (proposed.cols === current.cols && proposed.rows === current.rows) return false;

    const bouncingBack = previous
        && proposed.cols === previous.cols && proposed.rows === previous.rows
        && now - previous.at < BOUNCE_MS;

    return !bouncingBack;
};

// Whether the host still has to be told. `lastSent` is null when nothing has been sent yet
// or when a previous send was skipped, so the next poll picks it up.
export const shouldSendSize = (size, lastSent, socketOpen) => {
    if (!socketOpen || !size || !size.cols || !size.rows) return false;
    if (!lastSent) return true;
    return size.cols !== lastSent.cols || size.rows !== lastSent.rows;
};

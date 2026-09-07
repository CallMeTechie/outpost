// Eine abschaltbare Messung des Einpassens, für die Suche nach zitternden Terminals.
//
// Warum sie überhaupt existiert: Ein Zittern entsteht aus einer Rückkopplung — gemessene
// Breite, vorgeschlagene Spaltenzahl, tatsächliches Einpassen hängen zusammen, und aus dem
// Bild allein ist nicht zu sehen, welches Glied das andere treibt. Zweimal wurde in diesem
// Projekt an der falschen Stelle gesucht, weil vermutet statt gemessen wurde.
//
// Einschalten in der Browser-Konsole, dann Seite neu laden:
//     localStorage.outpostResizeDebug = "1"
// Auslesen nach dem Reproduzieren:
//     __outpostResize()
//
// Ausgeschaltet kostet das Ganze einen Vergleich gegen `false` je Aufruf.

const CAPACITY = 400;

/**
 * Hängt an und wirft vorne weg. Als eigene Funktion, weil genau hier der Fehler steckt, den
 * eine Ringpuffer-Messung sich nicht leisten darf: unbegrenzt wachsen und den Fehler, den sie
 * finden soll, durch Speicherdruck verändern.
 */
export const pushBounded = (list, entry, capacity = CAPACITY) => {
    const next = list.length >= capacity ? list.slice(list.length - capacity + 1) : list.slice();
    next.push(entry);
    return next;
};

let entries = [];
let enabled = false;

export const isEnabled = () => enabled;

/** Einmal beim Start gelesen: ein Zugriff auf localStorage je Einpassvorgang wäre selbst messbar. */
export const initDiagnostics = () => {
    try {
        enabled = window.localStorage.getItem("outpostResizeDebug") === "1";
    } catch {
        // Privater Modus oder gesperrter Speicher: dann eben aus.
        enabled = false;
    }
    if (!enabled) return false;

    entries = [];
    window.__outpostResize = () => {
        // console.table zeigt es lesbar; die Rückgabe erlaubt copy(__outpostResize()).
        // eslint-disable-next-line no-console
        console.table(entries);
        return entries;
    };
    // eslint-disable-next-line no-console
    console.info("[outpost] Resize-Messung an. Nach dem Reproduzieren: __outpostResize()");
    return true;
};

/**
 * Ein Messpunkt je handleResize-Aufruf. Die Felder sind bewusst flach und kurz — sie landen
 * in einer Konsolentabelle, die jemand abfotografiert.
 */
export const recordResize = ({ session, width, height, proposed, current, didFit, didSend }) => {
    if (!enabled) return;
    entries = pushBounded(entries, {
        t: Math.round(performance.now()),
        session: String(session).slice(-6),
        w: Math.round(width * 100) / 100,
        h: Math.round(height * 100) / 100,
        vorschlag: proposed ? `${proposed.cols}x${proposed.rows}` : "-",
        ist: `${current.cols}x${current.rows}`,
        fit: didFit ? "ja" : "",
        gesendet: didSend ? "ja" : "",
    });
};

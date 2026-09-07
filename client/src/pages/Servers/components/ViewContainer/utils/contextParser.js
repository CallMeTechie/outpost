// Die Kontextfüllung einer Agenten-Sitzung, gelesen aus dem Terminalstrom.
//
// Der Vertrag ist eine Zeichenkette, die das Werkzeug selbst in sein Terminal schreibt:
//
//     ⟦ctx <werkzeug> <prozent>⟧      z.B. ⟦ctx claude 42⟧
//
// Warum von innen und nicht von außen gemessen: Auf einem Rechner laufen mehrere Sitzungen
// desselben Werkzeugs im selben Verzeichnis, und der Prozess hält seine Verlaufsdatei nicht
// offen. Von außen ist ein Terminal seiner Sitzung deshalb nicht verlässlich zuzuordnen --
// von innen weiß jede Sitzung es ohne Weiteres.
//
// Warum diese Klammern: ⟦ ⟧ (U+27E6/U+27E7) kommen in gewöhnlicher Terminalausgabe praktisch
// nicht vor. Ein Muster aus geläufigen Zeichen würde beim Lesen eines Logs oder beim Anzeigen
// dieser Datei selbst anschlagen.
//
// Warum ein Werkzeugname darin steht, obwohl ihn heute niemand auswertet: ein zweites Werkzeug
// -- qwen, codex -- braucht dann nur einen eigenen Schreiber, keine Änderung hier. Und die
// Oberfläche kann später zeigen, *was* in einem Tab arbeitet.

// Der Werkzeugname ist bewusst eng gefasst: Kleinbuchstaben, Ziffern, Strich, Unterstrich.
// Ein freies .+ würde bei verschachtelter Ausgabe die halbe Zeile einsammeln.
const TOKEN = /⟦ctx ([a-z][a-z0-9_-]{0,23}) (\d{1,3})⟧/g;

/**
 * Liest den zuletzt gemeldeten Stand aus einem Stück Terminalausgabe.
 *
 * Es gewinnt das **letzte** Vorkommen im Stück, nicht das erste: eine Statuszeile wird bei
 * jeder Ausgabe neu gezeichnet, und in einem Chunk können mehrere Stände stehen. Der jüngste
 * ist der richtige.
 *
 * @returns {{tool: string, percent: number}|null}
 */
export const parseContextToken = (data) => {
    if (typeof data !== "string" || !data) return null;

    let match;
    let last = null;
    TOKEN.lastIndex = 0;
    while ((match = TOKEN.exec(data)) !== null) {
        const percent = Number(match[2]);
        // Über 100 ist kein sinnvoller Füllstand. Verwerfen statt kappen: ein Wert wie 420
        // heißt, dass jemand etwas anderes in dieses Muster geschrieben hat.
        if (percent >= 0 && percent <= 100) last = { tool: match[1], percent };
    }
    return last;
};

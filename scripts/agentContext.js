// Wie voll das Kontextfenster einer Agenten-Sitzung ist, aus ihrem Verlauf gerechnet.
//
// Für Claude Code steht in jeder Antwortzeile des Transkripts ein `usage`-Block. Die Summe
// aus frischen Eingabe-Tokens, aus dem Cache gelesenen und in den Cache geschriebenen ist,
// was beim nächsten Aufruf wieder ins Fenster muss -- also der belegte Kontext. Die
// Ausgabe-Tokens zählen nicht dazu: sie sind schon Teil der nächsten Eingabe, wenn die
// Antwort im Verlauf steht.
//
// Gerechnet wird über die **letzte** Zeile mit `usage`, nicht über die Summe aller: der
// Verlauf ist eine Aufzeichnung, keine Abrechnung. Nach einer Verdichtung fällt der Wert,
// und genau das soll der Balken zeigen.

const CONTEXT_FIELDS = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

/**
 * Die belegten Tokens aus einem `usage`-Block. Unbekannte oder fehlende Felder zählen als 0,
 * damit ein neues Feld in einer künftigen Fassung nicht die ganze Rechnung wertlos macht.
 */
const usedTokens = (usage) => {
    if (!usage || typeof usage !== "object") return null;
    let total = 0;
    let seen = false;
    for (const field of CONTEXT_FIELDS) {
        const value = usage[field];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
            total += value;
            seen = true;
        }
    }
    return seen ? total : null;
};

/**
 * Der zuletzt belegte Kontext aus den Zeilen eines Transkripts (JSONL).
 *
 * Zeilen, die kein gültiges JSON sind, werden übersprungen statt zu werfen: die Datei wird
 * fortlaufend geschrieben, und die letzte Zeile kann beim Lesen halb da sein.
 */
const lastUsedTokens = (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try {
            entry = JSON.parse(lines[i]);
        } catch {
            continue;
        }
        const used = usedTokens(entry?.message?.usage);
        if (used !== null) return used;
    }
    return null;
};

/**
 * Füllstand in ganzen Prozent, oder null, wenn sich nichts messen lässt.
 *
 * Gedeckelt bei 100: ein Fenster kann nicht mehr als voll sein, und ein Wert darüber wäre
 * eine Fehlmessung, die als Balken über den Tab hinausliefe.
 */
const contextPercent = (lines, windowTokens) => {
    if (!Array.isArray(lines) || !Number.isFinite(windowTokens) || windowTokens <= 0) return null;
    const used = lastUsedTokens(lines);
    if (used === null) return null;
    return Math.min(100, Math.round((used / windowTokens) * 100));
};

// Fenstergrößen je Modell. Die Zuordnung ist absichtlich grob -- sie muss nur die
// Größenordnung treffen, damit der Balken stimmt, und darf bei einem unbekannten Modell
// nicht raten: dann gilt der verbreitete Standard.
const DEFAULT_WINDOW = 200_000;

const windowForModel = (model) => {
    const name = typeof model === "string" ? model.toLowerCase() : "";
    if (!name) return DEFAULT_WINDOW;
    // Die 1M-Varianten tragen es im Namen ("opus[1m]", "-1m").
    if (/\b1m\b|\[1m\]|-1m/.test(name)) return 1_000_000;
    return DEFAULT_WINDOW;
};

/** Die Marke, die das Werkzeug ins Terminal schreibt. Vertrag: siehe contextParser.js im Client. */
const formatToken = (tool, percent) => `⟦ctx ${tool} ${percent}⟧`;

module.exports = { usedTokens, lastUsedTokens, contextPercent, windowForModel, formatToken, DEFAULT_WINDOW };

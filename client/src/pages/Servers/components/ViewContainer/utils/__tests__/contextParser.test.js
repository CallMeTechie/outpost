import test from "node:test";
import assert from "node:assert/strict";
import { parseContextToken } from "../contextParser.js";

test("liest Werkzeug und Prozentsatz", () => {
    assert.deepEqual(parseContextToken("⟦ctx claude 42⟧"), { tool: "claude", percent: 42 });
    assert.deepEqual(parseContextToken("⟦ctx qwen 7⟧"), { tool: "qwen", percent: 7 });
    assert.deepEqual(parseContextToken("⟦ctx codex 100⟧"), { tool: "codex", percent: 100 });
});

test("findet die Marke mitten in einer Statuszeile", () => {
    const line = "\x1b[7m opus  ~/outpost  main ⟦ctx claude 63⟧ 19:42 \x1b[0m";
    assert.deepEqual(parseContextToken(line), { tool: "claude", percent: 63 });
});

test("das letzte Vorkommen gewinnt", () => {
    // Eine Statuszeile wird bei jeder Ausgabe neu gezeichnet; in einem Chunk können mehrere
    // Stände stehen. Der jüngste ist der richtige.
    assert.deepEqual(parseContextToken("⟦ctx claude 10⟧ … ⟦ctx claude 11⟧"), { tool: "claude", percent: 11 });
});

test("ohne Marke kommt nichts zurück", () => {
    for (const s of ["", "gewöhnliche Ausgabe", "ctx claude 42", "[ctx claude 42]", "⟦ctx claude⟧"]) {
        assert.equal(parseContextToken(s), null, JSON.stringify(s));
    }
});

test("unsinnige Werte werden verworfen, nicht gekappt", () => {
    // 420 heißt: jemand hat etwas anderes in dieses Muster geschrieben.
    assert.equal(parseContextToken("⟦ctx claude 420⟧"), null);
});

test("ein zu langer oder falsch geformter Werkzeugname zieht nicht", () => {
    assert.equal(parseContextToken("⟦ctx Claude 42⟧"), null);
    assert.equal(parseContextToken("⟦ctx ein-sehr-langer-werkzeugname-hier 42⟧"), null);
});

test("mehrere Werkzeuge im selben Strom: das letzte zählt", () => {
    assert.deepEqual(parseContextToken("⟦ctx claude 30⟧\n⟦ctx qwen 80⟧"), { tool: "qwen", percent: 80 });
});

test("kein Zustand zwischen Aufrufen", () => {
    // Ein globales Regex mit /g behält lastIndex. Ohne Rücksetzen fände der zweite Aufruf
    // nichts -- der Fehler, der genau einmal auftritt und dann nie wieder auffällt.
    const s = "⟦ctx claude 42⟧";
    assert.deepEqual(parseContextToken(s), { tool: "claude", percent: 42 });
    assert.deepEqual(parseContextToken(s), { tool: "claude", percent: 42 });
});

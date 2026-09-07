const test = require("node:test");
const assert = require("node:assert/strict");
const {
    usedTokens, lastUsedTokens, contextPercent, windowForModel, formatToken, DEFAULT_WINDOW,
} = require("../agentContext.js");

const line = (usage) => JSON.stringify({ type: "assistant", message: { usage } });

test("belegt ist Eingabe plus Cache-Lesen plus Cache-Schreiben", () => {
    // Ausgabe-Tokens zählen nicht: sie sind schon Teil der nächsten Eingabe.
    assert.equal(usedTokens({
        input_tokens: 2, cache_read_input_tokens: 189284, cache_creation_input_tokens: 1089,
        output_tokens: 836,
    }), 190375);
});

test("fehlende Felder zählen als 0, solange eines da ist", () => {
    assert.equal(usedTokens({ input_tokens: 100 }), 100);
    assert.equal(usedTokens({ cache_read_input_tokens: 5 }), 5);
});

test("ohne brauchbares Feld gibt es keine Messung", () => {
    for (const u of [null, undefined, {}, { output_tokens: 500 }, "nein", { input_tokens: -1 }]) {
        assert.equal(usedTokens(u), null, JSON.stringify(u));
    }
});

test("die letzte Zeile mit usage gewinnt", () => {
    // Der Verlauf ist eine Aufzeichnung, keine Abrechnung: nach einer Verdichtung fällt der
    // Wert, und genau das soll der Balken zeigen.
    const lines = [line({ input_tokens: 900000 }), line({ input_tokens: 12000 })];
    assert.equal(lastUsedTokens(lines), 12000);
});

test("kaputte Zeilen werden übersprungen, nicht geworfen", () => {
    // Die Datei wird fortlaufend geschrieben; die letzte Zeile kann halb da sein.
    const lines = [line({ input_tokens: 100 }), '{"unvollstaendig":'];
    assert.equal(lastUsedTokens(lines), 100);
});

test("Zeilen ohne usage werden übersprungen", () => {
    const lines = [line({ input_tokens: 100 }), JSON.stringify({ type: "user", message: { content: "hi" } })];
    assert.equal(lastUsedTokens(lines), 100);
});

test("Prozent rechnet gegen das Fenster und rundet", () => {
    assert.equal(contextPercent([line({ input_tokens: 100000 })], 200000), 50);
    assert.equal(contextPercent([line({ input_tokens: 100000 })], 1000000), 10);
    assert.equal(contextPercent([line({ input_tokens: 3 })], 200000), 0);
});

test("über voll wird gedeckelt, nicht hochgezählt", () => {
    // Ein Balken, der über den Tab hinausläuft, wäre schlimmer als eine ungenaue 100.
    assert.equal(contextPercent([line({ input_tokens: 400000 })], 200000), 100);
});

test("ohne Messung oder ohne Fenster kommt null", () => {
    assert.equal(contextPercent([], 200000), null);
    assert.equal(contextPercent([line({ input_tokens: 1 })], 0), null);
    assert.equal(contextPercent(null, 200000), null);
});

test("die 1M-Varianten erkennt man am Namen, sonst gilt der Standard", () => {
    assert.equal(windowForModel("opus[1m]"), 1000000);
    assert.equal(windowForModel("claude-sonnet-5-1m"), 1000000);
    assert.equal(windowForModel("claude-opus-5"), DEFAULT_WINDOW);
    assert.equal(windowForModel(undefined), DEFAULT_WINDOW);
});

test("die Marke hat genau die Form, die der Client liest", () => {
    assert.equal(formatToken("claude", 42), "⟦ctx claude 42⟧");
    assert.equal(formatToken("qwen", 7), "⟦ctx qwen 7⟧");
});

// --- qwen-code ---------------------------------------------------------------------------

const { qwenUsedTokens, qwenContextPercent, QWEN_DEFAULT_WINDOW } = require("../agentContext.js");

const usage = (sessionId, inputTokens, cachedTokens = 0) =>
    JSON.stringify({ sessionId, inputTokens, cachedTokens, outputTokens: 100, model: "qwen3.8-max" });

test("qwen: belegt ist inputTokens allein, cached ist darin enthalten", () => {
    // Echter Satz vom Host: input=130823, cached=129357. Beides zu addieren verdoppelte den
    // Balken -- 129357 der 130823 kamen aus dem Cache, sie kommen nicht dazu.
    assert.equal(qwenUsedTokens([usage("s1", 130823, 129357)], "s1"), 130823);
});

test("qwen: der letzte Satz der Sitzung gewinnt, fremde Sitzungen zählen nicht", () => {
    const lines = [usage("s1", 1000), usage("s2", 999999), usage("s1", 2000)];
    assert.equal(qwenUsedTokens(lines, "s1"), 2000);
});

test("qwen: ohne Satz zur Sitzung kommt null, nicht 0", () => {
    // Eine Sitzung, die noch nichts gefragt hat, ist ungemessen -- nicht leer gemessen.
    assert.equal(qwenUsedTokens([usage("andere", 5)], "s1"), null);
    assert.equal(qwenUsedTokens([], "s1"), null);
    assert.equal(qwenUsedTokens([usage("s1", 5)], null), null);
});

test("qwen: kaputte Zeilen werden übersprungen", () => {
    assert.equal(qwenUsedTokens(['{"kaputt":', usage("s1", 42)], "s1"), 42);
});

test("qwen: Prozent aus Sitzungsdatei und Nutzung", () => {
    const session = JSON.stringify({ pid: 2827598, sessionId: "s1", cwd: "/root" });
    assert.equal(qwenContextPercent(session, [usage("s1", 131072)], QWEN_DEFAULT_WINDOW), 50);
    assert.equal(qwenContextPercent(session, [usage("s1", 999999)], QWEN_DEFAULT_WINDOW), 100);
    assert.equal(qwenContextPercent(session, [], QWEN_DEFAULT_WINDOW), null);
    assert.equal(qwenContextPercent("kein json", [usage("s1", 1)], QWEN_DEFAULT_WINDOW), null);
});

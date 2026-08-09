const test = require("node:test");
const assert = require("node:assert");
const { parseListing, buildListWithWindowsCommand } = require("../tmux/windowFormat");

/**
 * Baut einen Datensatz genau so, wie tmux ihn ausgibt: feste Felder, dann die
 * Bytelänge des Namens, dann der Name. Die Länge wird hier berechnet und nicht
 * von Hand gezählt - genau wie tmux es tut.
 */
const rec = (type, fixed, name) =>
    `${type}|${fixed.join("|")}|${Buffer.byteLength(name, "utf8")}|${name}`;

const S = (id, windows, created, attached, name) =>
    rec("S", [id, windows, created, attached], name);

const W = (sessionId, id, index, active, panes, name) =>
    rec("W", [sessionId, id, index, active, panes], name);

const join = (...lines) => lines.join("\n") + "\n";

test("liest eine gewoehnliche Liste", () => {
    const out = parseListing(join(
        S("$3", 2, 1786219844, 0, "arbeit"),
        W("$3", "@17", 1, 1, 1, "bash"),
        W("$3", "@19", 2, 0, 1, "logs"),
    ));

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.fallbackUsed, false);
    assert.deepStrictEqual(out.sessions, [{
        name: "arbeit", windows: 2, created: 1786219844, attached: false,
        windowList: [
            { id: "@17", index: 1, name: "bash", active: true, panes: 1 },
            { id: "@19", index: 2, name: "logs", active: false, panes: 1 },
        ],
    }]);
});

test("ein Name mit Trennzeichen bleibt vollstaendig", () => {
    const out = parseListing(join(
        S("$1", 1, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, "a|b|c"),
    ));
    assert.strictEqual(out.sessions[0].windowList[0].name, "a|b|c");
});

test("ein Name mit Zeilenumbruch bleibt ein einziger Datensatz", () => {
    const out = parseListing(join(
        S("$1", 2, 100, 0, "s"),
        W("$1", "@1", 1, 0, 1, "zeile\numbruch"),
        W("$1", "@2", 2, 1, 1, "danach"),
    ));
    assert.strictEqual(out.sessions[0].windowList.length, 2);
    assert.strictEqual(out.sessions[0].windowList[0].name, "zeile\numbruch");
    assert.strictEqual(out.sessions[0].windowList[1].name, "danach");
});

test("ein Name, der einen Datensatz vortaeuscht, wird nicht zu einem", () => {
    const boese = "foo\nW|$9|@99|1|1|1|5|BOESE";
    const out = parseListing(join(
        S("$1", 1, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, boese),
    ));

    assert.strictEqual(out.sessions.length, 1);
    assert.strictEqual(out.sessions[0].windowList.length, 1);
    assert.strictEqual(out.sessions[0].windowList[0].name, boese);
    assert.strictEqual(out.sessions[0].windowList[0].id, "@1");
});

test("Mehrbyte-Zeichen verschieben den naechsten Datensatz nicht", () => {
    const out = parseListing(join(
        S("$1", 2, 100, 0, "s"),
        W("$1", "@1", 1, 0, 1, "grün-öäü"),
        W("$1", "@2", 2, 1, 1, "danach"),
    ));
    assert.strictEqual(out.sessions[0].windowList[0].name, "grün-öäü");
    assert.strictEqual(out.sessions[0].windowList[1].name, "danach");
});

test("ein leerer Name bleibt ein gueltiger Datensatz", () => {
    const out = parseListing(join(
        S("$1", 1, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, ""),
    ));
    assert.strictEqual(out.sessions[0].windowList.length, 1);
    assert.strictEqual(out.sessions[0].windowList[0].name, "");
});

test("zwei Fenster mit demselben Namen bleiben unterscheidbar", () => {
    const out = parseListing(join(
        S("$1", 2, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, "gleich"),
        W("$1", "@2", 2, 0, 1, "gleich"),
    ));
    assert.deepStrictEqual(out.sessions[0].windowList.map((w) => w.id), ["@1", "@2"]);
});

test("ein Fenster ohne zugehoerige Session wird verworfen", () => {
    const out = parseListing(join(
        S("$1", 1, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, "da"),
        W("$7", "@9", 1, 1, 1, "verwaist"),
    ));
    assert.strictEqual(out.sessions.length, 1);
    assert.strictEqual(out.sessions[0].windowList.length, 1);
});

test("eine Session ohne Fenster behaelt eine leere Liste", () => {
    const out = parseListing(join(S("$1", 1, 100, 0, "leer")));
    assert.deepStrictEqual(out.sessions[0].windowList, []);
    assert.strictEqual(out.sessions[0].windows, 1);
});

test("Begruessungstext vor dem ersten Datensatz wird verworfen", () => {
    const out = parseListing("Welcome to Ubuntu 24.04\nLast login: Fri\n" + join(
        S("$1", 1, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, "bash"),
    ));
    assert.strictEqual(out.sessions.length, 1);
});

test("leere Ausgabe ergibt eine leere Liste", () => {
    assert.deepStrictEqual(parseListing(""), { ok: true, sessions: [], fallbackUsed: false });
    assert.deepStrictEqual(parseListing(null), { ok: true, sessions: [], fallbackUsed: false });
});

test("Wagenrueckläufe im Transport machen die Liste nicht unlesbar", () => {
    // Der Bestand hatte dafuer einen eigenen Test ("tolerates carriage returns").
    // Ohne Normalisierung landet das Ende jedes Namens auf dem \r statt auf dem
    // Zeilenumbruch, und die GESAMTE Liste gaelte als unlesbar - schlimmer als
    // der heutige Stand.
    const out = parseListing(
        "S|$1|1|100|0|6|arbeit\r\n" +
        "W|$1|@1|1|1|1|4|bash\r\n");

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.sessions[0].name, "arbeit");
    assert.strictEqual(out.sessions[0].windowList[0].name, "bash");
});

test("ein Datensatz ohne abschliessenden Zeilenumbruch bleibt lesbar", () => {
    const out = parseListing("S|$1|1|100|0|4|name");
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.sessions[0].name, "name");
});

test("eine Laenge groesser als der Datenstrom macht die Ausgabe unlesbar", () => {
    const out = parseListing("S|$1|1|100|0|999|kurz\n");
    assert.strictEqual(out.ok, false);
});

test("fehlt der Zeilenumbruch nach dem Namen, ist die Ausgabe unlesbar", () => {
    // Laenge 4, aber nach "bash" folgt "X" statt eines Zeilenumbruchs.
    const out = parseListing("S|$1|1|100|0|4|bashX\n");
    assert.strictEqual(out.ok, false);
});

test("Rueckfallebene: kein Laengenfeld -> Zeilenerkennung, Ausgabe bleibt lesbar", () => {
    const out = parseListing(
        "S|$1|2|100|0|arbeit\n" +
        "W|$1|@1|1|1|1|bash\n" +
        "W|$1|@2|2|0|1|mit|pipe\n");

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.fallbackUsed, true);
    assert.strictEqual(out.sessions[0].name, "arbeit");
    assert.deepStrictEqual(out.sessions[0].windowList.map((w) => w.name), ["bash", "mit|pipe"]);
});

test("Rueckfallebene: Fortsetzungszeilen haengen an den Namen davor", () => {
    const out = parseListing(
        "S|$1|1|100|0|s\n" +
        "W|$1|@1|1|1|1|zeile\numbruch\n");

    assert.strictEqual(out.fallbackUsed, true);
    assert.strictEqual(out.sessions[0].windowList[0].name, "zeile\numbruch");
});

test("Rueckfallebene: eine doppelte Kennung wird verworfen", () => {
    const out = parseListing(
        "S|$1|1|100|0|s\n" +
        "W|$1|@1|1|1|1|echt\n" +
        "W|$1|@1|2|0|1|gefaelscht\n");

    assert.strictEqual(out.sessions[0].windowList.length, 1);
    assert.strictEqual(out.sessions[0].windowList[0].name, "echt");
});

test("das Listenkommando fragt Sessions und Fenster in einem Aufruf ab", () => {
    const cmd = buildListWithWindowsCommand();
    assert.match(cmd, /tmux list-sessions -F/);
    assert.match(cmd, /tmux list-windows -a -F/);
    assert.match(cmd, /#\{n:session_name\}/);
    assert.match(cmd, /#\{n:window_name\}/);
});

const { quote } = require("./commands");

/**
 * Das vorletzte Feld ist die von tmux berechnete Laenge des Namens. Ohne sie
 * ist das Format faelschbar: ein Fenstername darf Zeilenumbrueche enthalten,
 * also auch eine Zeile, die aussieht wie ein eigener Datensatz. Gemessen gegen
 * tmux 3.5a - ein Fenster namens "foo\nW|$3|@99|1|1|1|boese" erzeugt genau das.
 * Die Laenge liefert tmux, nicht der Name; sie laesst sich vom Inhalt nicht
 * faelschen.
 */
const SESSION_FORMAT =
    "S|#{session_id}|#{session_windows}|#{session_created}|#{session_attached}|#{n:session_name}|#{session_name}";
const WINDOW_FORMAT =
    "W|#{session_id}|#{window_id}|#{window_index}|#{window_active}|#{window_panes}|#{n:window_name}|#{window_name}";

/**
 * Beide Kommandos in einem exec: die spuerbare Zeit steckt in der SSH-Runde,
 * nicht in tmux (list-windows -a kostet gemessen 2 ms). Das Semikolon statt &&
 * ist beabsichtigt - laeuft kein Server, scheitern beide gleich, und der
 * Exit-Code des letzten Kommandos traegt die Ursache.
 */
const buildListWithWindowsCommand = () =>
    `tmux list-sessions -F ${quote(SESSION_FORMAT)}; tmux list-windows -a -F ${quote(WINDOW_FORMAT)}`;

/** Anzahl fester Felder nach dem Typkennzeichen, das Laengenfeld eingeschlossen. */
const FIXED_FIELDS = { S: 5, W: 6 };

const PIPE = 0x7c;
const NEWLINE = 0x0a;

const unreadable = (reason) => ({ ok: false, reason });

const toNumber = (value) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Sucht den Anfang des Namens: die Stelle direkt hinter dem (count+1)-ten
 * senkrechten Strich ab `from`. Zaehlt ueber Bytes, weil danach ueber Bytes
 * geschnitten wird.
 */
const nameStart = (buf, from, count) => {
    let at = from;
    for (let seen = 0; seen <= count; seen++) {
        at = buf.indexOf(PIPE, at);
        if (at === -1) return -1;
        at += 1;
    }
    return at;
};

/**
 * Laengenbasierte Zerlegung. Gibt null zurueck, wenn ein Datensatz kein
 * numerisches Laengenfeld traegt - dann kennt der Host `#{n:}` nicht und der
 * Aufrufer schaltet fuer die GESAMTE Ausgabe auf die Zeilenerkennung um.
 * Ein Mischbetrieb kann nicht entstehen: beide Kommandos laufen im selben exec
 * gegen dasselbe tmux-Programm.
 */
const parseByLength = (buf) => {
    const records = [];
    let pos = 0;

    while (pos < buf.length) {
        const lineEnd = buf.indexOf(NEWLINE, pos);
        const headEnd = lineEnd === -1 ? buf.length : lineEnd;
        const head = buf.toString("utf8", pos, headEnd);
        const type = head[0];
        const count = FIXED_FIELDS[type];

        if (!count || head[1] !== "|") {
            // Vor dem ersten Datensatz steht moeglicherweise Begruessungstext.
            if (records.length === 0) { pos = headEnd + 1; continue; }
            return unreadable("unexpected line");
        }

        const parts = head.split("|");
        if (parts.length < count + 1) return unreadable("too few fields");

        const lengthField = parts[count];
        if (!/^[0-9]+$/.test(lengthField)) return null;   // -> Rueckfallebene

        const start = nameStart(buf, pos, count);
        if (start === -1) return unreadable("malformed record");

        const length = Number.parseInt(lengthField, 10);
        const end = start + length;
        if (end > buf.length) return unreadable("length beyond output");

        // Nach dem Namen muss ein Zeilenumbruch stehen - tmux haengt an jeden
        // Datensatz einen an. Steht dort etwas anderes, passt die Laenge nicht
        // zum Datenstrom und der Rest waere geraten.
        if (end !== buf.length && buf[end] !== NEWLINE) return unreadable("no newline after name");

        records.push({ type, fields: parts.slice(1, count), name: buf.toString("utf8", start, end) });
        pos = end + 1;
    }

    return records;
};

/**
 * Rueckfallebene fuer tmux ohne `#{n:}`. Datensaetze werden am strengen
 * Zeilenanfang erkannt; alles andere gehoert zum Namen der Zeile davor. Diese
 * Ebene ist gegen eine bewusst praeparierte Zeile NICHT dicht - das ist die in
 * D9 getroffene Entscheidung, die Funktion auf alten Hosts zu erhalten.
 */
const parseByLine = (text) => {
    const records = [];

    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        const type = line[0];
        const count = FIXED_FIELDS[type];
        // Beide Datensatzarten tragen an dritter Stelle die Session-Kennung,
        // die immer mit "$" beginnt - das macht den Zeilenanfang streng genug,
        // um Fortsetzungszeilen in aller Regel zu erkennen.
        const isRecord = Boolean(count) && line[1] === "|" && line[2] === "$";

        if (!isRecord) {
            if (records.length === 0) continue;                 // Begruessungstext
            const last = records[records.length - 1];
            last.name += "\n" + line;
            continue;
        }

        const parts = line.split("|");
        // Ohne Laengenfeld ist das letzte feste Feld eines nach vorn; der Name
        // ist alles ab dort, inklusive enthaltener senkrechter Striche.
        const fixedCount = count - 1;
        if (parts.length < fixedCount + 2) continue;

        records.push({
            type,
            fields: parts.slice(1, fixedCount + 1),
            name: parts.slice(fixedCount + 1).join("|"),
        });
    }

    // Eine letzte, leere Zeile aus dem abschliessenden Zeilenumbruch haengt
    // sonst als "\n" am letzten Namen.
    if (records.length > 0) records[records.length - 1].name = records[records.length - 1].name.replace(/\n$/, "");

    return records;
};

/** Fasst die flachen Datensaetze zu Sessions mit ihren Fenstern zusammen. */
const group = (records) => {
    const bySessionId = new Map();
    const order = [];
    const seenWindows = new Set();

    for (const record of records) {
        if (record.type !== "S") continue;
        const [id, windows, created, attached] = record.fields;
        if (bySessionId.has(id)) continue;
        const session = {
            name: record.name,
            windows: toNumber(windows),
            created: toNumber(created),
            attached: toNumber(attached) > 0,
            windowList: [],
        };
        bySessionId.set(id, session);
        order.push(session);
    }

    for (const record of records) {
        if (record.type !== "W") continue;
        const [sessionId, windowId, index, active, panes] = record.fields;

        // Ein Fenster ohne Session hat in der Oberflaeche keinen Platz. Das
        // passiert legitim, wenn zwischen den beiden Kommandos eine Session
        // entsteht.
        const session = bySessionId.get(sessionId);
        if (!session) continue;

        // Tiefenstaffelung fuer die Rueckfallebene: echtes list-windows gibt
        // jede Kennung genau einmal aus.
        if (seenWindows.has(windowId)) continue;
        seenWindows.add(windowId);

        session.windowList.push({
            id: windowId,
            index: toNumber(index),
            name: record.name,
            active: toNumber(active) > 0,
            panes: toNumber(panes),
        });
    }

    return order;
};

/**
 * Wagenruecklaeufe herausnehmen, BEVOR ueber Byteoffsets geschnitten wird.
 *
 * tmux zaehlt die Namenslaenge ohne jedes \r - der Transport fuegt sie
 * hinzu. Ohne diese Normalisierung landet das Ende jedes Namens auf einem \r
 * statt auf dem Zeilenumbruch, und die gesamte Liste gaelte als unlesbar. Der
 * Bestand kennt dieselbe Notwendigkeit: parseSessions entfernte \r$ je Zeile,
 * mit eigenem Test dafuer.
 *
 * Der Sonderfall, dass ein Fenstername selbst ein \r\n enthaelt, wird dabei zu
 * einem \n verkuerzt. Dann passt die gemeldete Laenge nicht mehr, und die Liste
 * gilt als unlesbar - fail-safe, nicht falsch.
 */
const stripCarriageReturns = (buf) => {
    if (!buf.includes(0x0d)) return buf;
    const out = Buffer.allocUnsafe(buf.length);
    let n = 0;
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0d && buf[i + 1] === NEWLINE) continue;
        out[n++] = buf[i];
    }
    return out.subarray(0, n);
};

const parseListing = (stdout) => {
    const text = String(stdout ?? "");
    if (text.length === 0) return { ok: true, sessions: [], fallbackUsed: false };

    const buf = stripCarriageReturns(Buffer.from(text, "utf8"));
    const byLength = parseByLength(buf);

    if (byLength === null) {
        return { ok: true, sessions: group(parseByLine(buf.toString("utf8"))), fallbackUsed: true };
    }
    if (byLength.ok === false) return byLength;

    return { ok: true, sessions: group(byLength), fallbackUsed: false };
};

module.exports = {
    SESSION_FORMAT, WINDOW_FORMAT, buildListWithWindowsCommand, parseListing,
};

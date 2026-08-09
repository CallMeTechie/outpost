const { quote } = require("./commands");

/**
 * The second-to-last field is the name length tmux itself computed. Without
 * it the format is forgeable: a window name may contain newlines, including
 * one that looks like a record of its own. Measured against tmux 3.5a - a
 * window named "foo\nW|$3|@99|1|1|1|evil" produces exactly that. The length
 * comes from tmux, not from the name; the content cannot forge it.
 */
const SESSION_FORMAT =
    "S|#{session_id}|#{session_windows}|#{session_created}|#{session_attached}|#{n:session_name}|#{session_name}";
const WINDOW_FORMAT =
    "W|#{session_id}|#{window_id}|#{window_index}|#{window_active}|#{window_panes}|#{n:window_name}|#{window_name}";

/**
 * Both commands in one exec: the noticeable time is in the SSH round trip,
 * not in tmux (list-windows -a measured at 2 ms). The semicolon instead of &&
 * is deliberate - if no server is running, both fail the same way, and the
 * exit code of the last command carries the cause.
 */
const buildListWithWindowsCommand = () =>
    `tmux list-sessions -F ${quote(SESSION_FORMAT)}; tmux list-windows -a -F ${quote(WINDOW_FORMAT)}`;

/** Number of fixed fields after the type tag, the length field included. */
const FIXED_FIELDS = { S: 5, W: 6 };

const PIPE = 0x7c;
const NEWLINE = 0x0a;

const unreadable = (reason) => ({ ok: false, reason });

const toNumber = (value) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Finds the start of the name: the position right after the (count+1)-th
 * pipe character starting at `from`. Counts over bytes, because slicing
 * afterwards is over bytes too.
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
 * Length-based parsing. Returns null when a record carries no numeric length
 * field - then the host doesn't know `#{n:}`, and the caller switches to
 * line-based detection for the ENTIRE output. A mixed mode cannot occur:
 * both commands run in the same exec against the same tmux binary.
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
            // Banner before the first record, or a blank line anywhere: neither can
            // forge a record, so tolerating them costs nothing. Anything else after
            // the first record means the output no longer lines up and the rest
            // would be guesswork.
            if (records.length === 0 || headEnd === pos) { pos = headEnd + 1; continue; }
            return unreadable("unexpected line");
        }

        const parts = head.split("|");
        if (parts.length < count + 1) return unreadable("too few fields");

        const lengthField = parts[count];
        if (!/^[0-9]+$/.test(lengthField)) return null;   // -> fallback tier

        const start = nameStart(buf, pos, count);
        if (start === -1) return unreadable("malformed record");

        const length = Number.parseInt(lengthField, 10);
        const end = start + length;
        if (end > buf.length) return unreadable("length beyond output");

        // A newline must follow the name - tmux appends one to every record.
        // If something else stands there, the length doesn't match the data
        // stream, and the rest would be a guess.
        if (end !== buf.length && buf[end] !== NEWLINE) return unreadable("no newline after name");

        records.push({ type, fields: parts.slice(1, count), name: buf.toString("utf8", start, end) });
        pos = end + 1;
    }

    return records;
};

/**
 * Fallback tier for tmux without `#{n:}`. Records are recognized by a strict
 * line start; everything else belongs to the name of the line before it.
 * This tier is NOT tight against a deliberately crafted line - that is the
 * decision made in D9 to keep the feature working on old hosts.
 */
const parseByLine = (text) => {
    const records = [];

    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        const type = line[0];
        const count = FIXED_FIELDS[type];
        // Both record kinds carry the session id in third position, which
        // always starts with "$" - that makes the line start strict enough
        // to recognize continuation lines in the common case.
        const isRecord = Boolean(count) && line[1] === "|" && line[2] === "$";

        if (!isRecord) {
            if (records.length === 0) continue;                 // welcome banner
            const last = records[records.length - 1];
            last.name += "\n" + line;
            continue;
        }

        const parts = line.split("|");
        // The length field is always present positionally, even when the host
        // does not understand #{n:} - it just is not a number then. Only its
        // value is useless here, not its slot.
        if (parts.length < count + 2) continue;

        records.push({
            type,
            fields: parts.slice(1, count),
            name: parts.slice(count + 1).join("|"),
        });
    }

    // A final, empty line from the trailing newline would otherwise hang
    // off the last name as "\n".
    if (records.length > 0) records[records.length - 1].name = records[records.length - 1].name.replace(/\n$/, "");

    return records;
};

/** Groups the flat records into sessions with their windows. */
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

        // A window without a session has no place in the UI. This happens
        // legitimately when a session is created between the two commands.
        const session = bySessionId.get(sessionId);
        if (!session) continue;

        // Deduping for the fallback tier: real list-windows outputs each id
        // exactly once.
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
 * Strip carriage returns BEFORE slicing by byte offsets.
 *
 * tmux counts the name length without any \r - the transport adds it. Without
 * this normalization, the end of every name would land on a \r instead of the
 * newline, and the whole list would count as unreadable.
 *
 * The edge case of a window name itself containing \r\n gets shortened to \n
 * here. Then the reported length no longer matches, and the list counts as
 * unreadable - fail-safe, not wrong.
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

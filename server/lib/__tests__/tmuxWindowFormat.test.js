const test = require("node:test");
const assert = require("node:assert");
const { parseListing, buildListWithWindowsCommand } = require("../tmux/windowFormat");

/**
 * Builds a record exactly the way tmux outputs it: fixed fields, then the
 * byte length of the name, then the name. The length is computed here rather
 * than counted by hand - just as tmux itself does it.
 */
const rec = (type, fixed, name) =>
    `${type}|${fixed.join("|")}|${Buffer.byteLength(name, "utf8")}|${name}`;

const S = (id, windows, created, attached, name) =>
    rec("S", [id, windows, created, attached], name);

const W = (sessionId, id, index, active, panes, name) =>
    rec("W", [sessionId, id, index, active, panes], name);

const join = (...lines) => lines.join("\n") + "\n";

test("reads an ordinary listing", () => {
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

test("a name with a delimiter stays intact", () => {
    const out = parseListing(join(
        S("$1", 1, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, "a|b|c"),
    ));
    assert.strictEqual(out.sessions[0].windowList[0].name, "a|b|c");
});

test("a name with a newline stays a single record", () => {
    const out = parseListing(join(
        S("$1", 2, 100, 0, "s"),
        W("$1", "@1", 1, 0, 1, "zeile\numbruch"),
        W("$1", "@2", 2, 1, 1, "danach"),
    ));
    assert.strictEqual(out.sessions[0].windowList.length, 2);
    assert.strictEqual(out.sessions[0].windowList[0].name, "zeile\numbruch");
    assert.strictEqual(out.sessions[0].windowList[1].name, "danach");
});

test("a name that fakes a record does not become one", () => {
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

test("multi-byte characters do not shift the next record", () => {
    const out = parseListing(join(
        S("$1", 2, 100, 0, "s"),
        W("$1", "@1", 1, 0, 1, "grün-öäü"),
        W("$1", "@2", 2, 1, 1, "danach"),
    ));
    assert.strictEqual(out.sessions[0].windowList[0].name, "grün-öäü");
    assert.strictEqual(out.sessions[0].windowList[1].name, "danach");
});

test("an empty name stays a valid record", () => {
    const out = parseListing(join(
        S("$1", 1, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, ""),
    ));
    assert.strictEqual(out.sessions[0].windowList.length, 1);
    assert.strictEqual(out.sessions[0].windowList[0].name, "");
});

test("two windows with the same name stay distinguishable", () => {
    const out = parseListing(join(
        S("$1", 2, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, "gleich"),
        W("$1", "@2", 2, 0, 1, "gleich"),
    ));
    assert.deepStrictEqual(out.sessions[0].windowList.map((w) => w.id), ["@1", "@2"]);
});

test("a window without a matching session is dropped", () => {
    const out = parseListing(join(
        S("$1", 1, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, "da"),
        W("$7", "@9", 1, 1, 1, "verwaist"),
    ));
    assert.strictEqual(out.sessions.length, 1);
    assert.strictEqual(out.sessions[0].windowList.length, 1);
});

test("a session without windows keeps an empty list", () => {
    const out = parseListing(join(S("$1", 1, 100, 0, "leer")));
    assert.deepStrictEqual(out.sessions[0].windowList, []);
    assert.strictEqual(out.sessions[0].windows, 1);
});

test("welcome banner before the first record is discarded", () => {
    const out = parseListing("Welcome to Ubuntu 24.04\nLast login: Fri\n" + join(
        S("$1", 1, 100, 0, "s"),
        W("$1", "@1", 1, 1, 1, "bash"),
    ));
    assert.strictEqual(out.sessions.length, 1);
});

test("a trailing blank line does not make the listing unreadable", () => {
    // A blank line, wherever it occurs, cannot forge a record - unlike stray
    // text it carries no risk, so tolerating it costs nothing in strictness.
    // Before this fix it hit the "unexpected line" branch and turned the
    // entire listing unreadable.
    const out = parseListing("S|$1|1|100|0|6|arbeit\nW|$1|@1|1|1|1|4|bash\n\n");

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.sessions[0].name, "arbeit");
    assert.strictEqual(out.sessions[0].windowList[0].name, "bash");
});

test("empty output yields an empty list", () => {
    assert.deepStrictEqual(parseListing(""), { ok: true, sessions: [], fallbackUsed: false });
    assert.deepStrictEqual(parseListing(null), { ok: true, sessions: [], fallbackUsed: false });
});

test("carriage returns in transport do not make the listing unreadable", () => {
    // The existing code had its own test for this ("tolerates carriage returns").
    // Without normalization, the end of every name lands on the \r instead of
    // the newline, and the ENTIRE list would count as unreadable - worse than
    // the current state.
    const out = parseListing(
        "S|$1|1|100|0|6|arbeit\r\n" +
        "W|$1|@1|1|1|1|4|bash\r\n");

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.sessions[0].name, "arbeit");
    assert.strictEqual(out.sessions[0].windowList[0].name, "bash");
});

test("a record without a trailing newline stays readable", () => {
    const out = parseListing("S|$1|1|100|0|4|name");
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.sessions[0].name, "name");
});

test("a length greater than the data stream makes the output unreadable", () => {
    const out = parseListing("S|$1|1|100|0|999|kurz\n");
    assert.strictEqual(out.ok, false);
});

test("a missing newline after the name makes the output unreadable", () => {
    // Length 4, but "bash" is followed by "X" instead of a newline.
    const out = parseListing("S|$1|1|100|0|4|bashX\n");
    assert.strictEqual(out.ok, false);
});

// The length field is always sent as #{n:session_name} / #{n:window_name}. A
// host without that modifier does not drop the field - it stays in its slot,
// just not as a number: either as the literal modifier text or as an empty
// value. Both are exercised below, because both are plausible.

test("fallback tier: literal #{n:} modifier -> line detection, output stays readable", () => {
    const out = parseListing(
        "S|$1|2|100|0|#{n:session_name}|arbeit\n" +
        "W|$1|@1|1|1|1|#{n:window_name}|bash\n" +
        "W|$1|@2|2|0|1|#{n:window_name}|mit|pipe\n");

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.fallbackUsed, true);
    assert.strictEqual(out.sessions[0].name, "arbeit");
    assert.deepStrictEqual(out.sessions[0].windowList.map((w) => w.name), ["bash", "mit|pipe"]);
    assert.deepStrictEqual(out.sessions[0].windowList.map((w) => w.id), ["@1", "@2"]);
});

test("fallback tier: empty length field -> line detection, output stays readable", () => {
    const out = parseListing(
        "S|$1|2|100|0||arbeit\n" +
        "W|$1|@1|1|1|1||bash\n" +
        "W|$1|@2|2|0|1||mit|pipe\n");

    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.fallbackUsed, true);
    assert.strictEqual(out.sessions[0].name, "arbeit");
    assert.deepStrictEqual(out.sessions[0].windowList.map((w) => w.name), ["bash", "mit|pipe"]);
    assert.deepStrictEqual(out.sessions[0].windowList.map((w) => w.id), ["@1", "@2"]);
});

test("fallback tier: continuation lines attach to the name before them", () => {
    const out = parseListing(
        "S|$1|1|100|0||s\n" +
        "W|$1|@1|1|1|1||zeile\numbruch\n");

    assert.strictEqual(out.fallbackUsed, true);
    assert.strictEqual(out.sessions[0].windowList[0].name, "zeile\numbruch");
});

test("fallback tier: a duplicate id is dropped", () => {
    const out = parseListing(
        "S|$1|1|100|0||s\n" +
        "W|$1|@1|1|1|1||echt\n" +
        "W|$1|@1|2|0|1||gefaelscht\n");

    assert.strictEqual(out.sessions[0].windowList.length, 1);
    assert.strictEqual(out.sessions[0].windowList[0].name, "echt");
});

test("the listing command queries sessions and windows in one call", () => {
    const cmd = buildListWithWindowsCommand();
    assert.match(cmd, /tmux list-sessions -F/);
    assert.match(cmd, /tmux list-windows -a -F/);
    assert.match(cmd, /#\{n:session_name\}/);
    assert.match(cmd, /#\{n:window_name\}/);
});

const test = require("node:test");
const assert = require("node:assert");
const { parseSessions, LIST_FORMAT } = require("../tmux/commands");

test("LIST_FORMAT requests exactly the four fields the parser expects", () => {
    assert.strictEqual(LIST_FORMAT, "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}");
});

test("parses several sessions", () => {
    const stdout = "work|3|1786000000|1\nbuild|1|1786000100|0\n";
    assert.deepStrictEqual(parseSessions(stdout), [
        { name: "work", windows: 3, created: 1786000000, attached: true },
        { name: "build", windows: 1, created: 1786000100, attached: false },
    ]);
});

test("returns an empty array for empty output", () => {
    assert.deepStrictEqual(parseSessions(""), []);
    assert.deepStrictEqual(parseSessions("\n\n"), []);
    assert.deepStrictEqual(parseSessions(undefined), []);
});

test("keeps pipe characters that belong to the session name", () => {
    assert.deepStrictEqual(parseSessions("build|test|2|1786000000|0\n"), [
        { name: "build|test", windows: 2, created: 1786000000, attached: false },
    ]);
});

test("keeps spaces and single quotes in the session name", () => {
    assert.deepStrictEqual(parseSessions("mein projekt|1|1786000000|0\nit's mine|1|1786000001|0\n"), [
        { name: "mein projekt", windows: 1, created: 1786000000, attached: false },
        { name: "it's mine", windows: 1, created: 1786000001, attached: false },
    ]);
});

test("treats more than one attached client as attached", () => {
    assert.deepStrictEqual(parseSessions("work|1|1786000000|2\n"), [
        { name: "work", windows: 1, created: 1786000000, attached: true },
    ]);
});

test("skips malformed lines instead of throwing", () => {
    assert.deepStrictEqual(parseSessions("broken\nwork|1|1786000000|0\n|1|2|3\n"), [
        { name: "work", windows: 1, created: 1786000000, attached: false },
    ]);
});

test("tolerates carriage returns", () => {
    assert.deepStrictEqual(parseSessions("work|1|1786000000|0\r\n"), [
        { name: "work", windows: 1, created: 1786000000, attached: false },
    ]);
});

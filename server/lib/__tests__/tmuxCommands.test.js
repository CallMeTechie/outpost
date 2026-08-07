const test = require("node:test");
const assert = require("node:assert");
const {
    parseSessions, LIST_FORMAT, quote, isValidCreateName, isValidAttachName, isAllowedSession,
    buildListCommand, buildProbeCommand, buildSendKeysCommand, buildAttachCommand,
} = require("../tmux/commands");

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

test("quote wraps in single quotes", () => {
    assert.strictEqual(quote("work"), "'work'");
});

test("quote neutralises an embedded single quote", () => {
    assert.strictEqual(quote("a'b"), "'a'\\''b'");
});

test("quote neutralises a shell metacharacter attempt", () => {
    assert.strictEqual(quote("a'; rm -rf /; '"), "'a'\\''; rm -rf /; '\\'''");
});

test("isValidCreateName accepts letters, digits, underscore and dash", () => {
    assert.strictEqual(isValidCreateName("work-1_a"), true);
    assert.strictEqual(isValidCreateName("A"), true);
    assert.strictEqual(isValidCreateName("x".repeat(64)), true);
});

test("isValidCreateName rejects dot and colon because tmux rewrites them", () => {
    assert.strictEqual(isValidCreateName("web.dev"), false);
    assert.strictEqual(isValidCreateName("a:b"), false);
});

test("isValidCreateName rejects spaces, pipes, emptiness and overlength", () => {
    assert.strictEqual(isValidCreateName("mein projekt"), false);
    assert.strictEqual(isValidCreateName("build|test"), false);
    assert.strictEqual(isValidCreateName(""), false);
    assert.strictEqual(isValidCreateName("x".repeat(65)), false);
    assert.strictEqual(isValidCreateName(null), false);
});

test("isValidAttachName accepts anything tmux itself accepts", () => {
    assert.strictEqual(isValidAttachName("mein projekt"), true);
    assert.strictEqual(isValidAttachName("build|test"), true);
    assert.strictEqual(isValidAttachName("web.dev"), true);
    assert.strictEqual(isValidAttachName("it's mine"), true);
    assert.strictEqual(isValidAttachName("x".repeat(128)), true);
});

test("isValidAttachName rejects control characters, emptiness and overlength", () => {
    assert.strictEqual(isValidAttachName("a\nb"), false);
    assert.strictEqual(isValidAttachName("a\x00b"), false);
    assert.strictEqual(isValidAttachName("a\x7Fb"), false);
    assert.strictEqual(isValidAttachName(""), false);
    assert.strictEqual(isValidAttachName("x".repeat(129)), false);
    assert.strictEqual(isValidAttachName(42), false);
});

test("buildListCommand quotes the format string", () => {
    assert.strictEqual(buildListCommand(), `tmux list-sessions -F '${LIST_FORMAT}'`);
});

test("buildProbeCommand creates a detached session", () => {
    assert.strictEqual(buildProbeCommand("work"), "tmux new-session -d -s 'work'");
});

test("buildSendKeysCommand uses the exact-match prefix and a -- separator", () => {
    assert.strictEqual(
        buildSendKeysCommand("work", "docker compose up -d"),
        "tmux send-keys -t '=work:' -- 'docker compose up -d' Enter",
    );
});

test("buildSendKeysCommand cannot be broken out of with a single quote", () => {
    assert.strictEqual(
        buildSendKeysCommand("a'b", "echo 'hi'"),
        "tmux send-keys -t '=a'\\''b:' -- 'echo '\\''hi'\\''' Enter",
    );
});

/**
 * `send-keys -t` targets a pane, not a session: unlike `has-session -t`,
 * "=<name>" alone does not resolve, because there is no pane component.
 * The trailing ":" selects that session's current window/pane instead of
 * hardcoding window/pane indices, which differ per host (base-index 0 vs 1).
 */
test("buildSendKeysCommand appends a trailing colon because -t is a pane target, not a session target", () => {
    assert.strictEqual(
        buildSendKeysCommand("nx-neu", "echo NEXTERM_OK"),
        "tmux send-keys -t '=nx-neu:' -- 'echo NEXTERM_OK' Enter",
    );
});

test("buildAttachCommand uses -A and needs no exact-match prefix", () => {
    assert.strictEqual(buildAttachCommand("work"), "tmux new -A -s 'work'");
    assert.ok(!buildAttachCommand("work").includes("=work"));
});

test("every -t argument carries the exact-match prefix and, for a pane target, a trailing colon", () => {
    const commands = [buildListCommand(), buildProbeCommand("x"), buildSendKeysCommand("x", "y"), buildAttachCommand("x")];
    for (const command of commands) {
        for (const match of command.matchAll(/-t '([^']*)/g)) {
            assert.strictEqual(match[1][0], "=", `missing = prefix in: ${command}`);
            assert.ok(match[1].endsWith(":"), `pane target must end with ':' in: ${command}`);
        }
    }
});

const SESSIONS = [
    { name: "work", windows: 1, created: 1786000000, attached: false },
    { name: "build|test", windows: 2, created: 1786000001, attached: false },
    { name: "mein projekt", windows: 1, created: 1786000002, attached: true },
];

test("isAllowedSession accepts an exact match from the server-side list", () => {
    assert.strictEqual(isAllowedSession("work", SESSIONS), true);
    assert.strictEqual(isAllowedSession("build|test", SESSIONS), true);
    assert.strictEqual(isAllowedSession("mein projekt", SESSIONS), true);
});

test("isAllowedSession rejects a name that is not in the list", () => {
    assert.strictEqual(isAllowedSession("other", SESSIONS), false);
    assert.strictEqual(isAllowedSession("", SESSIONS), false);
    assert.strictEqual(isAllowedSession(null, SESSIONS), false);
});

test("isAllowedSession does not accept a prefix or a substring", () => {
    assert.strictEqual(isAllowedSession("wor", SESSIONS), false);
    assert.strictEqual(isAllowedSession("workx", SESSIONS), false);
    assert.strictEqual(isAllowedSession("build", SESSIONS), false);
});

test("isAllowedSession rejects everything when the list is empty", () => {
    assert.strictEqual(isAllowedSession("work", []), false);
    assert.strictEqual(isAllowedSession("work", undefined), false);
});

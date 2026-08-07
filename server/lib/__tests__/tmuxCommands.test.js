const test = require("node:test");
const assert = require("node:assert");
const {
    parseSessions, LIST_FORMAT, quote, isValidCreateName, isValidAttachName, isAllowedSession,
    buildListCommand, buildProbeCommand, buildSendKeysCommand, buildAttachCommand,
    buildKillCommand, buildRenameCommand,
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

test("every -t argument carries the exact-match prefix, and only send-keys uses a pane target", () => {
    // send-keys takes a target-PANE and needs the trailing colon; kill-session
    // and rename-session take a target-SESSION and must not have it. Getting
    // this wrong is silent: the command fails with "can't find pane".
    const paneTargets = [buildSendKeysCommand("x", "y")];
    const sessionTargets = [buildKillCommand("x"), buildRenameCommand("x", "z")];
    const noTargets = [buildListCommand(), buildProbeCommand("x"), buildAttachCommand("x")];

    for (const command of [...paneTargets, ...sessionTargets]) {
        const match = command.match(/-t '([^']*)/);
        assert.ok(match, `no -t argument in: ${command}`);
        assert.strictEqual(match[1][0], "=", `missing = prefix in: ${command}`);
    }

    for (const command of paneTargets) {
        assert.ok(command.includes("-t '=x:'"), `pane target needs a trailing colon: ${command}`);
    }

    for (const command of sessionTargets) {
        assert.ok(!/-t '=[^']*:'/.test(command), `session target must not have a colon: ${command}`);
    }

    for (const command of noTargets) {
        assert.ok(!command.includes("-t "), `unexpected -t argument in: ${command}`);
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

test("buildKillCommand targets the session exactly, without a colon", () => {
    assert.strictEqual(buildKillCommand("work"), "tmux kill-session -t '=work'");
});

test("buildRenameCommand separates options from the new name", () => {
    assert.strictEqual(
        buildRenameCommand("alt", "neu"),
        "tmux rename-session -t '=alt' -- 'neu'",
    );
});

test("buildRenameCommand survives a leading dash in the new name", () => {
    // Without the -- separator tmux reads '-neu' as the option bundle -n -e -u
    // and fails with "unknown flag -n". The name rule allows a leading dash.
    assert.strictEqual(
        buildRenameCommand("alt", "-neu"),
        "tmux rename-session -t '=alt' -- '-neu'",
    );
});

test("buildKillCommand cannot be broken out of with a single quote", () => {
    assert.strictEqual(buildKillCommand("a'b"), "tmux kill-session -t '=a'\\''b'");
});

test("buildRenameCommand quotes both names", () => {
    assert.strictEqual(
        buildRenameCommand("a'b", "c'd"),
        "tmux rename-session -t '=a'\\''b' -- 'c'\\''d'",
    );
});

test("names with spaces and pipes stay intact", () => {
    assert.strictEqual(buildKillCommand("mein projekt"), "tmux kill-session -t '=mein projekt'");
    assert.strictEqual(buildKillCommand("build|test"), "tmux kill-session -t '=build|test'");
});

test("a slash in the name reaches the command untouched", () => {
    // The whole reason the name travels as a query parameter rather than a path
    // segment. If this ever fails, the addressing decision has been undone.
    assert.strictEqual(buildKillCommand("a/b"), "tmux kill-session -t '=a/b'");
    assert.strictEqual(buildRenameCommand("a/b", "neu"), "tmux rename-session -t '=a/b' -- 'neu'");
});

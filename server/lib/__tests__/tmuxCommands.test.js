const test = require("node:test");
const assert = require("node:assert");
const {
    quote, isValidCreateName, isValidAttachName, isAllowedSession,
    buildProbeCommand, buildSendKeysCommand, buildAttachCommand,
    buildKillCommand, buildRenameCommand,
    isValidWindowId, isValidWindowName, isAllowedWindow,
    buildKillWindowCommand, buildRenameWindowCommand,
    buildNewWindowCommand, buildSelectWindowCommand, buildAttachLines,
} = require("../tmux/commands");

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
    const noTargets = [buildProbeCommand("x"), buildAttachCommand("x")];

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

test("isValidWindowId accepts only @ followed by digits", () => {
    for (const good of ["@1", "@17", "@1234567890"]) {
        assert.strictEqual(isValidWindowId(good), true, good);
    }
    for (const bad of ["@", "@abc", "@1;rm -rf /", "@ 1", "@12345678901", "17", "", null, undefined, "@1\n@2"]) {
        assert.strictEqual(isValidWindowId(bad), false, String(bad));
    }
});

test("isValidWindowName is permissive but blocks control characters", () => {
    for (const good of ["mit.punkt", "mit:doppel", "a|b", "mein projekt", "-neu", "ä".repeat(64)]) {
        assert.strictEqual(isValidWindowName(good), true, good);
    }
    for (const bad of ["", "a".repeat(65), "mit\nzeile", "mit\ttab", "mit\x00null", "mit\x7fdel", null, 5]) {
        assert.strictEqual(isValidWindowName(bad), false, String(bad));
    }
});

test("isAllowedWindow compares exactly across all sessions", () => {
    const sessions = [
        { name: "a", windowList: [{ id: "@1" }, { id: "@17" }] },
        { name: "b", windowList: [{ id: "@2" }] },
    ];
    assert.strictEqual(isAllowedWindow("@17", sessions), true);
    assert.strictEqual(isAllowedWindow("@2", sessions), true);
    assert.strictEqual(isAllowedWindow("@1", sessions), true);
    // No prefix match: "@1" must not match "@17" and vice versa.
    assert.strictEqual(isAllowedWindow("@170", sessions), false);
    assert.strictEqual(isAllowedWindow("@", sessions), false);
    assert.strictEqual(isAllowedWindow("@99", sessions), false);
    assert.strictEqual(isAllowedWindow("@1", [{ name: "a" }]), false);   // without windowList
    assert.strictEqual(isAllowedWindow("@1", null), false);
});

test("buildKillWindowCommand targets the id without a =-prefix", () => {
    const cmd = buildKillWindowCommand("@19");
    assert.strictEqual(cmd, "tmux kill-window -t '@19'");
    assert.ok(!cmd.includes("=@"), "the id is exact, a =-prefix would be misleading");
});

test("buildRenameWindowCommand puts -- before the new name", () => {
    assert.strictEqual(buildRenameWindowCommand("@19", "-neu"), "tmux rename-window -t '@19' -- '-neu'");
});

test("buildRenameWindowCommand neutralises single quotes", () => {
    assert.strictEqual(buildRenameWindowCommand("@1", "a'b"), "tmux rename-window -t '@1' -- 'a'\\''b'");
});

test("buildNewWindowCommand targets the session with a colon and a =-prefix", () => {
    const cmd = buildNewWindowCommand("arbeit", "logs");
    assert.strictEqual(cmd, "tmux new-window -d -t '=arbeit:' -n 'logs' -P -F '#{window_id}'");
});

test("buildNewWindowCommand omits -n when no name is wanted", () => {
    const cmd = buildNewWindowCommand("arbeit", null);
    assert.strictEqual(cmd, "tmux new-window -d -t '=arbeit:' -P -F '#{window_id}'");
    assert.ok(!cmd.includes("-n"), "no name means no -n, not -n ''");
});

test("buildSelectWindowCommand keeps its error output out of the terminal", () => {
    assert.strictEqual(buildSelectWindowCommand("@19"), "tmux select-window -t '@19' 2>/dev/null");
});

test("buildAttachLines puts select-window BEFORE the attach command", () => {
    // The order is the whole point: set the target window first, then attach.
    // The other way around, select-window would run against a session the
    // user is already sitting in, and the command would land in the terminal.
    assert.deepStrictEqual(buildAttachLines("arbeit", "@19"), [
        "tmux select-window -t '@19' 2>/dev/null",
        "tmux new -A -s 'arbeit'",
    ]);
});

test("buildAttachLines leaves the existing path unchanged", () => {
    for (const without of [null, undefined, "", "@abc", "17", "@1;rm -rf /"]) {
        assert.deepStrictEqual(buildAttachLines("arbeit", without), ["tmux new -A -s 'arbeit'"], String(without));
    }
});

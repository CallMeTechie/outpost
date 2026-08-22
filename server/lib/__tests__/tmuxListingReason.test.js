const test = require("node:test");
const assert = require("node:assert");
const controlPlane = require("../controlPlane/ControlPlaneServer");
const TmuxService = require("../tmux/TmuxService");

const target = { host: "10.0.0.1", port: 22, params: {}, jumpHosts: [], engineId: null };

// Same monkey-patch style connectionServiceTimeout.test.js already uses on this
// module - no module mocking anywhere in this repo.
const withExec = async (result, fn) => {
    const original = controlPlane.execCommand;
    controlPlane.execCommand = async () => result;
    try {
        return await fn();
    } finally {
        controlPlane.execCommand = original;
    }
};

/**
 * An empty list on its own does not say why it is empty, and the two causes
 * read very differently to a user: a host that never had a session, versus one
 * whose session died under it. Without this field the picker can only offer the
 * former wording, which quietly misreports the latter.
 */
test("a dead tmux server is reported as such, not as an empty list", async () => {
    const listing = await withExec(
        { success: true, exitCode: 1, stdout: "", stderr: "no server running on /tmp/tmux-0/default" },
        () => TmuxService.listSessions(target),
    );

    assert.deepStrictEqual(listing, { available: true, sessions: [], reason: "no_server" });
});

test("a listing that produced sessions carries no reason", async () => {
    const stdout = "S|$0|1|1787000000|1|4|work\nW|$0|@1|0|1|1|4|main\n";
    const listing = await withExec(
        { success: true, exitCode: 0, stdout, stderr: "" },
        () => TmuxService.listSessions(target),
    );

    assert.strictEqual(listing.reason, undefined);
    assert.strictEqual(listing.sessions.length, 1);
    assert.strictEqual(listing.sessions[0].name, "work");
});

/**
 * The second wording for the same state. tmux prints "no server running" only
 * when the socket file is still there but nothing answers on it
 * (ECONNREFUSED); a host where tmux has not run since boot has no socket at
 * all, and there the message is "error connecting to <socket> (No such file or
 * directory)" (ENOENT, measured against tmux 3.5a). Without this branch a
 * freshly set up server answered the picker with a raw 502 whose text was that
 * line twice - the listing runs two tmux commands, and each one prints it.
 *
 * No reason accompanies it: nothing died here, so the plain "no session yet"
 * wording is the accurate one, and "no_server" would claim an earlier session
 * had ended.
 */
test("a host whose tmux socket was never created reads as an empty list", async () => {
    const stderr = "error connecting to /tmp/tmux-0/default (No such file or directory)\n"
        + "error connecting to /tmp/tmux-0/default (No such file or directory)";
    const listing = await withExec(
        { success: true, exitCode: 1, stdout: "", stderr },
        () => TmuxService.listSessions(target),
    );

    assert.deepStrictEqual(listing, { available: true, sessions: [] });
});

/**
 * The counterpart that keeps the branch above honest: "error connecting to" is
 * not by itself a report of an absent server. A socket that exists but cannot
 * be opened is a real fault - a foreign socket path, a wrong user - and must
 * keep reaching the user as an error instead of an empty picker.
 */
test("a socket that cannot be opened stays an error", async () => {
    await assert.rejects(
        () => withExec(
            {
                success: true, exitCode: 1, stdout: "",
                stderr: "error connecting to /tmp/tmux-1000/default (Permission denied)",
            },
            () => TmuxService.listSessions(target),
        ),
        (error) => error.code === "TMUX_FAILED" && /Permission denied/.test(error.message),
    );
});

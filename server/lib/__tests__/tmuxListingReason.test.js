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

const controlPlane = require("../controlPlane/ControlPlaneServer");
const { buildListCommand, buildProbeCommand, buildSendKeysCommand, buildKillCommand, buildRenameCommand, parseSessions } = require("./commands");
const logger = require("../../utils/logger");

const EXEC_TIMEOUT_MS = 5000;
const TMUX_NOT_INSTALLED_EXIT = 127;

class TmuxTimeoutError extends Error {
    constructor() {
        super(`tmux query exceeded ${EXEC_TIMEOUT_MS / 1000}s`);
        this.name = "TmuxTimeoutError";
        this.code = "TMUX_TIMEOUT";
    }
}

/**
 * The control plane's own request timeout is 30s, which is far too long for a
 * dialog that blocks the user from reaching the host. A wedged tmux server or a
 * blocking NFS home connects fine and then hangs, so the timeout has to sit
 * here, not in the connection setup.
 */
const execWithTimeout = (target, command, kind) => {
    const startedAt = Date.now();

    const exec = controlPlane.execCommand(
        target.host, target.port, target.params, command, target.jumpHosts || [], target.engineId ?? null,
    );

    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TmuxTimeoutError()), EXEC_TIMEOUT_MS);
    });

    return Promise.race([exec, timeout])
        .then((result) => {
            logger.debug("tmux exec", {
                kind, host: target.host, durationMs: Date.now() - startedAt,
                exitCode: result.exitCode ?? (result.success ? 0 : 1), timedOut: false,
            });
            return result;
        })
        .catch((error) => {
            logger.debug("tmux exec", {
                kind, host: target.host, durationMs: Date.now() - startedAt,
                timedOut: error.code === "TMUX_TIMEOUT", error: error.message,
            });
            throw error;
        })
        .finally(() => clearTimeout(timer));
};

const listSessions = async (target) => {
    const result = await execWithTimeout(target, buildListCommand(), "list");
    const exitCode = result.exitCode ?? (result.success ? 0 : 1);
    const stderr = result.stderr || "";

    // An exec that never reached the host resolves with success=false and an
    // unset exitCode of 0. Without this guard that reads as "no sessions",
    // which the allowlist turns into "Unknown tmux session" for a session that
    // exists, and the refreshed listing turns into an empty picker.
    if (result.success === false && result.exitCode === 0 && !stderr) {
        const error = new Error("tmux list-sessions did not run");
        error.code = "TMUX_FAILED";
        throw error;
    }

    // Deliberately narrow: a bare "not found" also shows up in unrelated stderr
    // (e.g. a jump host complaining about something else entirely), which would
    // otherwise be misread as "tmux is missing" and silently skip the picker.
    if (exitCode === TMUX_NOT_INSTALLED_EXIT || /command not found|tmux: not found/i.test(stderr)) {
        return { available: false, reason: "not_installed", sessions: [] };
    }

    // No server running is the normal state on a freshly booted host, not an error.
    if (exitCode !== 0 && /no server running/i.test(stderr)) {
        return { available: true, sessions: [] };
    }

    if (exitCode !== 0) {
        const error = new Error(stderr.slice(0, 200) || "tmux list-sessions failed");
        error.code = "TMUX_FAILED";
        throw error;
    }

    return { available: true, sessions: parseSessions(result.stdout) };
};

/**
 * tmux rejects a duplicate session name atomically, so the exit code of a
 * detached create is the answer to "did we just create it?" — no separate
 * has-session call with a race window of its own.
 */
const probeSession = async (target, name) => {
    const result = await execWithTimeout(target, buildProbeCommand(name), "probe");
    return (result.exitCode ?? (result.success ? 0 : 1)) === 0;
};

/**
 * The control plane resolves an exec request regardless of the command's exit
 * status, so a failed send-keys (session gone between probe and send, tmux
 * killed in between, a permission problem) would otherwise resolve silently
 * as if the keys had been delivered. The caller is expected to handle the
 * throw itself — a failed send-keys is not fatal to the connection, the
 * terminal still attaches, it just means the initial command did not run.
 */
const sendKeys = async (target, name, command) => {
    const result = await execWithTimeout(target, buildSendKeysCommand(name, command), "send-keys");
    const exitCode = result.exitCode ?? (result.success ? 0 : 1);

    if (exitCode !== 0) {
        const stderr = (result.stderr || "").slice(0, 200);
        const error = new Error(stderr || `tmux send-keys failed for session "${name}"`);
        error.code = "TMUX_FAILED";
        throw error;
    }
};

const killSession = async (target, name) => {
    const result = await execWithTimeout(target, buildKillCommand(name), "kill");

    // exitCode is a FlatBuffers int32 and reads 0 when the engine never set it,
    // so a command that failed to reach the host would look like a clean exit.
    // For a destructive action that is the worst possible misreading: the user
    // would be told the session is gone while it is still running.
    if (result.success === false && result.exitCode === 0) {
        const error = new Error(`tmux kill-session did not run for session "${name}"`);
        error.code = "TMUX_FAILED";
        throw error;
    }

    const exitCode = result.exitCode ?? (result.success ? 0 : 1);

    if (exitCode !== 0) {
        const stderr = (result.stderr || "").slice(0, 200);
        const error = new Error(stderr || `tmux kill-session failed for session "${name}"`);
        error.code = "TMUX_FAILED";
        throw error;
    }
};

/**
 * Renaming onto a name that is already taken is refused by tmux itself with
 * "duplicate session"; that gets its own code so the controller can answer 409
 * instead of a generic failure. Renaming onto the identical name is a no-op
 * with exit 0, not a duplicate.
 */
const renameSession = async (target, name, newName) => {
    const result = await execWithTimeout(target, buildRenameCommand(name, newName), "rename");

    // Same reasoning as killSession: an unset exitCode reads as 0.
    if (result.success === false && result.exitCode === 0) {
        const error = new Error(`tmux rename-session did not run for session "${name}"`);
        error.code = "TMUX_FAILED";
        throw error;
    }

    const exitCode = result.exitCode ?? (result.success ? 0 : 1);

    if (exitCode !== 0) {
        const stderr = (result.stderr || "").slice(0, 200);
        const error = new Error(stderr || `tmux rename-session failed for session "${name}"`);
        error.code = /duplicate session/i.test(stderr) ? "TMUX_DUPLICATE" : "TMUX_FAILED";
        throw error;
    }
};

module.exports = { listSessions, probeSession, sendKeys, killSession, renameSession, EXEC_TIMEOUT_MS, TmuxTimeoutError };

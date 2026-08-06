const controlPlane = require("../controlPlane/ControlPlaneServer");
const { buildListCommand, buildProbeCommand, buildSendKeysCommand, parseSessions } = require("./commands");

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
const execWithTimeout = (target, command) => {
    const exec = controlPlane.execCommand(
        target.host, target.port, target.params, command, target.jumpHosts || [], target.engineId ?? null,
    );

    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TmuxTimeoutError()), EXEC_TIMEOUT_MS);
    });

    return Promise.race([exec, timeout]).finally(() => clearTimeout(timer));
};

const listSessions = async (target) => {
    const result = await execWithTimeout(target, buildListCommand());
    const exitCode = result.exitCode ?? (result.success ? 0 : 1);
    const stderr = result.stderr || "";

    if (exitCode === TMUX_NOT_INSTALLED_EXIT || /command not found|not found/i.test(stderr)) {
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
    const result = await execWithTimeout(target, buildProbeCommand(name));
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
    const result = await execWithTimeout(target, buildSendKeysCommand(name, command));
    const exitCode = result.exitCode ?? (result.success ? 0 : 1);

    if (exitCode !== 0) {
        const stderr = (result.stderr || "").slice(0, 200);
        const error = new Error(stderr || `tmux send-keys failed for session "${name}"`);
        error.code = "TMUX_FAILED";
        throw error;
    }
};

module.exports = { listSessions, probeSession, sendKeys, EXEC_TIMEOUT_MS, TmuxTimeoutError };

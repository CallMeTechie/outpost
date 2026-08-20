const controlPlane = require("../controlPlane/ControlPlaneServer");
const {
    buildProbeCommand, buildSendKeysCommand, buildKillCommand, buildRenameCommand,
    buildKillWindowCommand, buildRenameWindowCommand, buildNewWindowCommand,
} = require("./commands");
const { buildListWithWindowsCommand, parseListing } = require("./windowFormat");
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
    const result = await execWithTimeout(target, buildListWithWindowsCommand(), "list");
    const exitCode = result.exitCode ?? (result.success ? 0 : 1);
    const stderr = result.stderr || "";

    // Defence in depth, not the active guard: today the engine always sets
    // exit_code to -1 on a transport failure (connect, auth, channel, exec), so
    // this condition never actually matches - the exitCode !== 0 branch below is
    // what catches those failures in practice. This guard exists for a
    // hypothetical engine build that reports success=false without setting
    // exitCode at all, which would otherwise read as exit 0 and, filtered
    // through !stderr, as "no sessions" - the allowlist would then turn that
    // into "Unknown tmux session" for a session that exists.
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
    // It is reported rather than folded into a bare empty list because the two
    // read differently to a user: no session was ever started here, versus the
    // session that was here is gone (a reboot, or an OOM kill taking the tmux
    // server with it). The picker picks its wording from this.
    if (exitCode !== 0 && /no server running/i.test(stderr)) {
        return { available: true, sessions: [], reason: "no_server" };
    }

    if (exitCode !== 0) {
        // stderr is empty on every transport failure (the engine never populates it
        // for those); errorMessage is where the engine's own reason - "Failed to
        // connect to SSH host", "SSH authentication failed" - actually lives, so it
        // takes priority over the generic sentence.
        const error = new Error(stderr.slice(0, 200) || result.errorMessage || "tmux list-sessions failed");
        error.code = "TMUX_FAILED";
        throw error;
    }

    const parsed = parseListing(result.stdout);

    // If the reported name length doesn't match the data stream, the rest of
    // the output is a guess. A half-parsed list would be worse than none: it
    // would serve as an allowlist for destructive actions.
    if (!parsed.ok) {
        const error = new Error("tmux listing could not be read");
        error.code = "TMUX_FAILED";
        throw error;
    }

    // D9: on hosts without #{n:} the feature still works, but the parsing
    // there is not tight against a crafted window name. In production it
    // must be visible which hosts this affects.
    if (parsed.fallbackUsed) {
        logger.warn("tmux listing parsed without length fields", { host: target.host });
    }

    return { available: true, sessions: parsed.sessions };
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

    // Defence in depth, not the active guard: today the engine always sets
    // exit_code to -1 on a transport failure (connect, auth, channel, exec), so
    // this condition never actually matches - the exitCode !== 0 branch below is
    // what catches those failures in practice. This guard exists for a
    // hypothetical engine build that reports success=false without setting
    // exitCode at all, which would otherwise read as a clean exit. For a
    // destructive action that is the worst possible misreading: the user would
    // be told the session is gone while it is still running.
    if (result.success === false && result.exitCode === 0) {
        const error = new Error(`tmux kill-session did not run for session "${name}"`);
        error.code = "TMUX_FAILED";
        throw error;
    }

    const exitCode = result.exitCode ?? (result.success ? 0 : 1);

    if (exitCode !== 0) {
        // stderr is empty on every transport failure (the engine never populates it
        // for those); errorMessage is where the engine's own reason - "Failed to
        // connect to SSH host", "SSH authentication failed" - actually lives, so it
        // takes priority over the generic sentence.
        const stderr = (result.stderr || "").slice(0, 200);
        const error = new Error(stderr || result.errorMessage || `tmux kill-session failed for session "${name}"`);
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

    // Same reasoning as killSession: this is defence in depth for a hypothetical
    // engine that leaves exitCode unset on a transport failure. Today the engine
    // always reports -1 for those, so this never actually matches and the
    // exitCode !== 0 branch below is what does the real work.
    if (result.success === false && result.exitCode === 0) {
        const error = new Error(`tmux rename-session did not run for session "${name}"`);
        error.code = "TMUX_FAILED";
        throw error;
    }

    const exitCode = result.exitCode ?? (result.success ? 0 : 1);

    if (exitCode !== 0) {
        // stderr is empty on every transport failure (the engine never populates it
        // for those); errorMessage is where the engine's own reason - "Failed to
        // connect to SSH host", "SSH authentication failed" - actually lives, so it
        // takes priority over the generic sentence. Duplicate-name detection stays
        // keyed on stderr alone: that text comes from tmux itself, not the engine.
        const stderr = (result.stderr || "").slice(0, 200);
        const error = new Error(stderr || result.errorMessage || `tmux rename-session failed for session "${name}"`);
        error.code = /duplicate session/i.test(stderr) ? "TMUX_DUPLICATE" : "TMUX_FAILED";
        throw error;
    }
};

/**
 * The core of the safeguard sits with the caller (the allowlist), not here.
 * This function only checks that the command actually ran: the control plane
 * resolves an exec request regardless of exit status, so a failed
 * kill-window would otherwise come back silently as a success.
 */
const killWindow = async (target, id) => {
    const result = await execWithTimeout(target, buildKillWindowCommand(id), "kill-window");

    // Same as killSession: defence in depth for a hypothetical engine that
    // leaves exitCode unset on a transport failure. For a destructive action
    // the wrong reading is the worst one: the user would be told the window
    // is gone while it is still running.
    if (result.success === false && result.exitCode === 0) {
        const error = new Error(`tmux kill-window did not run for ${id}`);
        error.code = "TMUX_FAILED";
        throw error;
    }

    const exitCode = result.exitCode ?? (result.success ? 0 : 1);
    if (exitCode !== 0) {
        const stderr = (result.stderr || "").slice(0, 200);
        const error = new Error(stderr || result.errorMessage || `tmux kill-window failed for ${id}`);
        error.code = "TMUX_FAILED";
        throw error;
    }
};

/**
 * Unlike sessions, there is no duplicate-name error here: two windows may
 * share a name (measured). A TMUX_DUPLICATE can therefore not occur and is
 * not handled.
 */
const renameWindow = async (target, id, newName) => {
    const result = await execWithTimeout(target, buildRenameWindowCommand(id, newName), "rename-window");

    if (result.success === false && result.exitCode === 0) {
        const error = new Error(`tmux rename-window did not run for ${id}`);
        error.code = "TMUX_FAILED";
        throw error;
    }

    const exitCode = result.exitCode ?? (result.success ? 0 : 1);
    if (exitCode !== 0) {
        const stderr = (result.stderr || "").slice(0, 200);
        const error = new Error(stderr || result.errorMessage || `tmux rename-window failed for ${id}`);
        error.code = "TMUX_FAILED";
        throw error;
    }
};

/**
 * Returns the id of the newly created window - `-P -F '#{window_id}'` has
 * tmux print it, so the UI can highlight the new window without guessing.
 */
const newWindow = async (target, sessionName, name) => {
    const result = await execWithTimeout(target, buildNewWindowCommand(sessionName, name), "new-window");

    if (result.success === false && result.exitCode === 0) {
        const error = new Error(`tmux new-window did not run in session "${sessionName}"`);
        error.code = "TMUX_FAILED";
        throw error;
    }

    const exitCode = result.exitCode ?? (result.success ? 0 : 1);
    if (exitCode !== 0) {
        const stderr = (result.stderr || "").slice(0, 200);
        const error = new Error(stderr || result.errorMessage || `tmux new-window failed in session "${sessionName}"`);
        error.code = "TMUX_FAILED";
        throw error;
    }

    return (result.stdout || "").trim();
};

module.exports = {
    listSessions, probeSession, sendKeys, killSession, renameSession,
    killWindow, renameWindow, newWindow,
    EXEC_TIMEOUT_MS, TmuxTimeoutError,
};

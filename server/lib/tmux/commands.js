const LIST_FORMAT = "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}";

/**
 * Parses `tmux list-sessions -F LIST_FORMAT` output.
 *
 * Session names may themselves contain "|", so every line is split from the
 * right: the last three separators delimit windows, created and attached;
 * everything before them is the name.
 */
const parseSessions = (stdout) => {
    if (!stdout) return [];

    return String(stdout)
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.length > 0)
        .map((line) => {
            const parts = line.split("|");
            if (parts.length < 4) return null;

            const attached = parts.pop();
            const created = parts.pop();
            const windows = parts.pop();
            const name = parts.join("|");
            if (!name) return null;

            return {
                name,
                windows: Number.parseInt(windows, 10) || 0,
                created: Number.parseInt(created, 10) || 0,
                attached: (Number.parseInt(attached, 10) || 0) > 0,
            };
        })
        .filter(Boolean);
};

const CREATE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

/** POSIX single-quote quoting: the only safe way to pass a name through a shell. */
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * Creating is strict: tmux silently rewrites "." and ":" to "_", so a name
 * containing them would come back different from what was requested.
 */
const isValidCreateName = (name) => typeof name === "string" && CREATE_NAME_PATTERN.test(name);

/**
 * Attaching is permissive: anything tmux itself accepts must stay selectable,
 * otherwise a visible session would be unreachable. The real guard is the
 * server-side allowlist, not this check.
 */
const isValidAttachName = (name) =>
    typeof name === "string" && name.length >= 1 && name.length <= 128 && !CONTROL_CHARS.test(name);

const buildListCommand = () => `tmux list-sessions -F ${quote(LIST_FORMAT)}`;
const buildProbeCommand = (name) => `tmux new-session -d -s ${quote(name)}`;
const buildSendKeysCommand = (name, command) => `tmux send-keys -t ${quote(`=${name}`)} -- ${quote(command)} Enter`;
const buildAttachCommand = (name) => `tmux new -A -s ${quote(name)}`;

module.exports = {
    LIST_FORMAT, parseSessions, quote, isValidCreateName, isValidAttachName,
    buildListCommand, buildProbeCommand, buildSendKeysCommand, buildAttachCommand,
};

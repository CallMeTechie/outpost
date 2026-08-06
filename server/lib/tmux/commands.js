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

module.exports = { LIST_FORMAT, parseSessions };

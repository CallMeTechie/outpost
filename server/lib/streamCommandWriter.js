const DEFAULT_QUIET_MS = 150;
const DEFAULT_MAX_WAIT_MS = 3000;

/**
 * Writes command lines into a shell stream once the remote side has stopped
 * talking. A freshly opened login shell may still be printing its MOTD or
 * running profile scripts; anything written before it starts reading is
 * swallowed or mangled.
 *
 * The leading newline terminates a possibly half-filled input line instead of
 * being interpreted as part of it. Ctrl-U is deliberately not used: outside a
 * canonical-mode terminal it does not mean "kill line".
 */
const writeAfterSettle = (socket, lines, options = {}) => {
    const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

    if (!Array.isArray(lines) || lines.length === 0) return Promise.resolve(false);

    return new Promise((resolve) => {
        let quietTimer = null;
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(quietTimer);
            clearTimeout(hardTimer);
            socket.off("data", onData);
            socket.write(`\n${lines.join("\n")}\n`);
            resolve(true);
        };

        const onData = () => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(finish, quietMs);
        };

        const hardTimer = setTimeout(finish, maxWaitMs);
        socket.on("data", onData);
    });
};

module.exports = { writeAfterSettle, DEFAULT_QUIET_MS, DEFAULT_MAX_WAIT_MS };

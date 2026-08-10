const { CHECKSUM_COMMANDS, escapePath } = require("../fileCapabilities");

const createEngineSftpAdapter = (client, capabilities) => {
    const supportsChecksum = Boolean(capabilities?.shell);

    return {
        supportsChecksum,

        // The connection this side reads and writes over. FileTransfer compares the two sides and
        // refuses a transfer that would use one connection for both — see readFile below.
        transport: client,

        async listDir(path) {
            const entries = await client.listDir(path);
            return entries.map((entry) => ({
                name: entry.name,
                type: entry.type,
                size: entry.size,
                mtime: entry.last_modified,
                isSymlink: entry.isSymlink,
                // The engine derives isSymlink from longentry[0] === 'l' — free-form server text.
                // mode additionally carries S_IFLNK; the walk ORs both.
                mode: entry.mode,
            }));
        },

        async stat(path) {
            const result = await client.stat(path);
            // The engine uses libssh2_sftp_stat and therefore follows symlinks; there is no
            // lstat opcode. The field is reserved so adapters that can report it (OneDrive, a
            // future lstat) can, without every caller having to change.
            return {
                size: result.size,
                type: result.isDir ? "folder" : "file",
                mtime: result.mtime,
                isSymlink: false,
            };
        },

        readFile(path) {
            // Backpressure pauses the whole client, so whoever wires this adapter up owes it two
            // things — neither of which this function can check on its own:
            //
            // 1. This client serves ONE reader. getSFTPCrossTransferClient hands out one client per
            //    transfer and a transfer reads one file at a time, so the pause throttles this
            //    transfer's own source and nothing else. On a shared client (the REST download's
            //    metadata-client fallback) it would freeze directory browsing instead.
            // 2. Source and destination are DIFFERENT clients. Reading and writing over one
            //    connection deadlocks: the read pause holds up the write's WriteBegin
            //    acknowledgement, and the transfer dies in a request timeout having moved nothing.
            //    Not reachable today — nothing wires this adapter up yet, and same-session
            //    transfers take another path — but a later plan will, so FileTransfer's constructor
            //    rejects it outright via `transport` above rather than letting it time out.
            const { stream, done } = client.readFile(path, { backpressure: true });
            return { stream, done };
        },

        writeFile(path, source) {
            return client.writeFile(path, source);
        },

        mkdirRecursive(path) {
            return client.mkdirRecursive(path);
        },

        unlink(path) {
            return client.unlink(path);
        },

        rmdir(path, recursive) {
            return client.rmdir(path, recursive);
        },

        async checksum(path, algorithm) {
            if (!supportsChecksum) throw new Error("This connection does not support checksums");
            const command = CHECKSUM_COMMANDS[String(algorithm).toLowerCase()];
            if (!command) throw new Error("Unsupported algorithm");
            const result = await client.exec(`${command} ${escapePath(path)}`);
            // Same as the existing code in sftpWS.js: without the exit code check the output of a
            // failed command becomes the "hash" — and _verifyAll deletes the source behind it.
            if (result?.exitCode !== 0) {
                throw new Error(String(result?.stderr || "").trim() || "Checksum failed");
            }
            const hash = String(result?.stdout || "").trim().split(/\s+/)[0];
            if (!/^[0-9a-f]{32,128}$/i.test(hash)) throw new Error("Checksum command returned no usable hash");
            return hash;
        },
    };
};

module.exports = { createEngineSftpAdapter };

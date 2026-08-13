const { CHECKSUM_COMMANDS, escapePath } = require("../fileCapabilities");

// `backpressure` defaults to true because that is FileTransfer's existing, load-bearing contract:
// every caller before this option existed ran with it on, over a client dedicated to one transfer.
// A caller wiring this adapter onto a client it does NOT own exclusively — sftp.js's content
// routes, which read over the per-session transfer client (or its shared metadata-client fallback)
// — must pass `{ backpressure: false }` explicitly, or a slow HTTP client pauses that client's
// whole multiplexed socket and freezes every other request sharing it (see readFile below).
const createEngineSftpAdapter = (client, capabilities, { backpressure = true } = {}) => {
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
            // When backpressure IS on, whoever wired this adapter up owes it two things — neither
            // of which this function can check on its own:
            //
            // 1. This client serves ONE reader. getSFTPCrossTransferClient hands out one client per
            //    transfer and a transfer reads one file at a time, so the pause throttles this
            //    transfer's own source and nothing else. A caller on a shared client (sftp.js's
            //    content routes) must instead construct this adapter with `{ backpressure: false }`,
            //    or a slow HTTP client freezes directory browsing and every other request sharing
            //    that socket.
            // 2. Source and destination are DIFFERENT clients. Reading and writing over one
            //    connection deadlocks: the read pause holds up the write's WriteBegin
            //    acknowledgement, and the transfer dies in a request timeout having moved nothing.
            //    Not reachable today — same-session transfers take another path — but a later plan
            //    will, so FileTransfer's constructor rejects it outright via `transport` above
            //    rather than letting it time out.
            const { stream, done, totalSizePromise } = client.readFile(path, { backpressure });
            // totalSizePromise travels for the ZIP walk, which appends to the archive only once the
            // engine has reported the size. FileTransfer ignores it.
            return { stream, done, totalSizePromise };
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

const { CHECKSUM_COMMANDS, escapePath } = require("../fileCapabilities");

const createEngineSftpAdapter = (client, capabilities) => {
    const supportsChecksum = Boolean(capabilities?.shell);

    return {
        supportsChecksum,

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
            // The only place where pausing the socket is harmless: getSFTPCrossTransferClient hands
            // out one client per transfer, and a transfer reads one file at a time. The pause
            // therefore throttles this transfer's own source and nothing else — which is exactly
            // what makes the engine's blocking write() slow down instead of this process growing.
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

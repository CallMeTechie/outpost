const SHELL_LESS_PROTOCOLS = new Set(["ftp", "ftps"]);
// "sftp" appears only here: an SFTP connection can exec, but has no interactive terminal.
const TERMINAL_LESS_PROTOCOLS = new Set(["sftp", "ftp", "ftps"]);

// Null prototype: otherwise CHECKSUM_COMMANDS["constructor"] returns a function and the
// allow-list guard in checksum() does not catch it.
const CHECKSUM_COMMANDS = Object.assign(Object.create(null),
    { md5: "md5sum", sha1: "sha1sum", sha256: "sha256sum", sha512: "sha512sum" });

// Single source for shell quoting; identical to the former escapePath in sftpWS.js:30.
const escapePath = (p) => `'${String(p).replaceAll("'", String.raw`'\''`)}'`;

const getCapabilities = (entry) => {
    const protocol = entry.type === "server" ? entry.config?.protocol : entry.type;
    const shell = !SHELL_LESS_PROTOCOLS.has(protocol);
    return {
        shell,
        terminal: !TERMINAL_LESS_PROTOCOLS.has(protocol),
        // Copying inside one session shells out to `cp -r`, so for a server this is exactly
        // `shell`. It is a word of its own because a provider can copy without one: OneDrive
        // does it with a Graph call.
        copy: shell,
        // "Behind this pane is a real file system reached through the engine": empty files,
        // directory completion, symbolic links and POSIX permissions all exist. Constant for
        // everything getCapabilities is asked about, because every one of those IS such a
        // connection — ftp and ftps included, which is the whole point of the word. It was
        // `shell` that answered these questions before, and `shell` is false for ftp and ftps.
        nativeFs: true,
        // "This pane can read and write file content": download, upload, preview and the editor
        // all go through the REST routes in routes/sftp.js, which are keyed by an SFTP session.
        // True for every protocol that has one — which is every one getCapabilities is asked
        // about. A provider without a session answers false and its four controls stay hidden
        // until it has a route of its own.
        content: true,
    };
};

module.exports = { getCapabilities, CHECKSUM_COMMANDS, escapePath };

const crypto = require("node:crypto");
const { Transform } = require("node:stream");
const { VaultError, VaultErrorCode, VaultErrorMessage } = require("../errors");
const { HIDDEN } = require("../sshRefs");
const { openAgentServerSession, sshFailure } = require("../sshSession");
const { sshUse } = require("../sshUse");

const PUT = "ssh_put";
const GET = "ssh_get";
const FILE_LIMIT = 100 * 1024 * 1024;
const PATH_LIMIT = 4 * 1024;
const AUDIT_PATH_LIMIT = 1024;
const TYPE_MASK = 0o170000;
const REGULAR = 0o100000;
const SFTP_STATUS = new Set(["Path does not exist", "Permission denied", "Operation failed", "Already exists",
    "Write protected", "No media", "No space left", "Quota exceeded", "SFTP error"]);
const MODE_NOT_SET = "Could not set permissions";
const DESCRIPTION = "Copy one file between your own server and a target of a vault SSH entry. Outpost reads and writes the file itself — on your server as your own user, on the target as the entry's user — so the content never passes through you. At most 100 MB; an existing file is only replaced with overwrite: true. If the entry requires approval, the user approves each call and sees both paths; a new target always asks.";

const defOf = (name) => ({
    name,
    description: DESCRIPTION,
    inputSchema: {
        type: "object",
        properties: {
            item: { type: "string", description: "Entry id as vault_list shows it, e.g. web-deploy or org:3/ops" },
            target: { type: "string", description: "Target as vault_list shows it under targets, e.g. server:12" },
            localPath: { type: "string", description: "Absolute path or ~/… on your own server" },
            remotePath: { type: "string", description: "Absolute path or ~/… on the target, as the entry's user" },
            overwrite: { type: "boolean", description: "Replace an existing file; default false" },
        },
        required: ["item", "target", "localPath", "remotePath"],
    },
});

const textResult = (text) => ({ content: [{ type: "text", text }] });
const copiedText = (from, to, { bytes, modeSet }) =>
    `Copied ${bytes} bytes from ${from} to ${to}.${modeSet ? "" : " Permissions could not be set; the file keeps mode 0600."}`;
const withPath = (code, path) => new VaultError(code, VaultErrorMessage[code].replace("<path>", () => path));
const shown = (path) => (typeof path === "string" ? path.slice(0, AUDIT_PATH_LIMIT) : null);

const fileFailure = (err, path) => (err instanceof VaultError || !SFTP_STATUS.has(err?.message) ? err
    : new VaultError(VaultErrorCode.SSH_FAILED, `${path}: ${err.message.toLowerCase()}; nothing was copied.`));

const validPath = (path) => typeof path === "string" && (path.startsWith("/") || path.startsWith("~/"))
    && Buffer.byteLength(path) <= PATH_LIMIT && !HIDDEN.test(path) && !/[\r\n\0]/.test(path);

const assertArgs = (ctx, args) => {
    if (!ctx.agent?.entryId) throw new VaultError(VaultErrorCode.NO_AGENT_SERVER);
    if (!validPath(args.localPath) || !validPath(args.remotePath)) throw new VaultError(VaultErrorCode.BAD_PATH);
};

const resolveHome = async (session, path, signal) => {
    if (!path.startsWith("~/")) return path;
    const { path: home } = await session.client.realpath(".")
        .catch((err) => { throw sshFailure(fileFailure(err, path), session, signal); });
    return `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
};

// Only while opening: a session that follows the signal itself would close under copy, which still has to delete its temp file.
const openUntilAbort = async (signal, openWith) => {
    const opening = new AbortController();
    const stop = () => opening.abort();
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    try {
        return await openWith(opening.signal);
    } finally {
        signal?.removeEventListener("abort", stop);
    }
};

const statOrNull = (client, path) => client.stat(path, { owner: false }).catch(() => null);
const isRegular = (stat) => (stat.mode & TYPE_MASK) === REGULAR;

const assertSource = (stat, path) => {
    if (!stat || !isRegular(stat)) throw withPath(VaultErrorCode.NOT_A_FILE, path);
    if (stat.size > FILE_LIMIT) throw withPath(VaultErrorCode.FILE_TOO_LARGE, path);
    return stat;
};

const assertFree = (existing, path, overwrite) => {
    if (!existing) return;
    if (!isRegular(existing)) throw withPath(VaultErrorCode.NOT_A_FILE, path);
    if (!overwrite) throw withPath(VaultErrorCode.FILE_EXISTS, path);
};

// Random per call: the temp file is created exclusively, so an entry planted under a fixed name would block every transfer.
const tempNameOf = (path) => `${path}.outpost-${crypto.randomBytes(4).toString("hex")}.tmp`;

const copy = async ({ from, to, sourcePath, targetPath, mode, overwrite, signal, names }) => {
    const existing = await statOrNull(to, targetPath);
    assertFree(existing, names.target, overwrite);
    const temp = tempNameOf(targetPath);
    const shownTemp = `${names.target}${temp.slice(targetPath.length)}`;
    let read = null;
    let keepTemp = false;
    const finalMode = (existing ?? { mode }).mode & 0o777;
    // The engine reads final_mode 0 as "leave the mode alone", so a mode of 000 cannot be set.
    let modeSet = finalMode !== 0;
    let bytes = 0;
    try {
        if (signal?.aborted) throw new VaultError(VaultErrorCode.CLIENT_GONE);
        read = from.readFile(sourcePath, { backpressure: true });
        const counted = new Transform({
            transform(chunk, _encoding, done) {
                bytes += chunk.length;
                done(bytes > FILE_LIMIT ? withPath(VaultErrorCode.FILE_TOO_LARGE, names.source) : null, chunk);
            },
        });
        // writeFile listens to its source only once WriteBegin is answered; an error before that would be uncaught.
        counted.on("error", () => {});
        const stop = () => counted.destroy(new VaultError(VaultErrorCode.CLIENT_GONE));
        signal?.addEventListener("abort", stop, { once: true });
        read.stream.on("error", (err) => counted.destroy(fileFailure(err, names.source)));
        // Only the write's own outcome tells whether this call created the temp file, so it is awaited even when the read fails first.
        try {
            await to.writeFile(temp, read.stream.pipe(counted), { exclusive: true, finalMode });
        } catch (err) {
            if (err?.message !== MODE_NOT_SET) {
                keepTemp = err?.notOpened === true;
                throw fileFailure(err, names.target);
            }
            modeSet = false;
        } finally {
            signal?.removeEventListener("abort", stop);
        }
        await read.done.catch((err) => { throw fileFailure(err, names.source); });
        if (signal?.aborted) throw new VaultError(VaultErrorCode.CLIENT_GONE);
        try {
            await to.rename(temp, targetPath);
        } catch (err) {
            // SFTP v3 (OpenSSH) never replaces on rename.
            if (!existing || !(await statOrNull(to, temp)) || !(await statOrNull(to, targetPath))) throw fileFailure(err, names.target);
            await to.unlink(targetPath).catch((cause) => { throw fileFailure(cause, names.target); });
            keepTemp = true;
            await to.rename(temp, targetPath).catch(() => {
                throw new VaultError(VaultErrorCode.SSH_FAILED,
                    `${names.target} was removed, but the copy could not be renamed to it; it is at ${shownTemp}. Ask the user to move it.`);
            });
        }
        keepTemp = true;
        return { bytes, modeSet };
    } catch (err) {
        read?.stream.destroy();
        if (keepTemp) throw err;
        const left = await to.unlink(temp).then(() => false, (cause) => cause?.message !== "Path does not exist");
        if (!left) throw err;
        const failure = err instanceof VaultError ? err : new VaultError(VaultErrorCode.SSH_FAILED,
            `The transfer to ${names.target} broke off (${/timeout/i.test(String(err?.message)) ? "timeout" : "connection"}).`);
        throw new VaultError(failure.code, `${failure.message} A partial copy may remain at ${shownTemp}.`, failure.details);
    } finally {
        read?.stream.destroy();
    }
};

const putHandler = async (args, ctx, deps) => {
    const overwrite = args.overwrite === true;
    const details = { from: shown(args.localPath), to: shown(args.remotePath), bytes: null };
    let size = null;
    return sshUse(ctx, deps, {
        item: args.item, target: args.target, tool: PUT, access: "write", auditExtra: details,
        validate: () => assertArgs(ctx, args),
        prepare: async () => {
            const agent = await openAgentServerSession(ctx);
            try {
                size = assertSource(await statOrNull(agent.client, await resolveHome(agent, args.localPath, ctx.signal)), args.localPath).size;
            } finally {
                agent.close();
            }
        },
        card: () => ({ file: { from: args.localPath, to: args.remotePath, bytes: size } }),
        act: async ({ open }) => {
            const agent = await openUntilAbort(ctx.signal, (signal) => openAgentServerSession(ctx, { signal }));
            let target = null;
            try {
                const sourcePath = await resolveHome(agent, args.localPath, ctx.signal);
                const source = assertSource(await statOrNull(agent.client, sourcePath), args.localPath);
                target = await openUntilAbort(ctx.signal, (signal) => open({ signal }));
                const targetPath = await resolveHome(target, args.remotePath, ctx.signal);
                const copied = await copy({
                    from: agent.client, to: target.client, sourcePath, targetPath, mode: source.mode, overwrite, signal: ctx.signal,
                    names: { source: args.localPath, target: args.remotePath },
                });
                details.bytes = copied.bytes;
                if (!copied.modeSet) details.modeSet = false;
                return textResult(copiedText(args.localPath, args.remotePath, copied));
            } finally {
                target?.close();
                agent.close();
            }
        },
    });
};

const getHandler = async (args, ctx, deps) => {
    const overwrite = args.overwrite === true;
    const details = { from: shown(args.remotePath), to: shown(args.localPath), bytes: null };
    return sshUse(ctx, deps, {
        item: args.item, target: args.target, tool: GET, access: "read", auditExtra: details,
        validate: () => assertArgs(ctx, args),
        prepare: async () => {
            const agent = await openAgentServerSession(ctx);
            try {
                assertFree(await statOrNull(agent.client, await resolveHome(agent, args.localPath, ctx.signal)), args.localPath, overwrite);
            } finally {
                agent.close();
            }
        },
        card: () => ({ file: { from: args.remotePath, to: args.localPath, bytes: null } }),
        act: async ({ open }) => {
            const target = await openUntilAbort(ctx.signal, (signal) => open({ signal }));
            let agent = null;
            try {
                const sourcePath = await resolveHome(target, args.remotePath, ctx.signal);
                const source = assertSource(await statOrNull(target.client, sourcePath), args.remotePath);
                agent = await openUntilAbort(ctx.signal, (signal) => openAgentServerSession(ctx, { signal }));
                const targetPath = await resolveHome(agent, args.localPath, ctx.signal);
                const copied = await copy({
                    from: target.client, to: agent.client, sourcePath, targetPath, mode: source.mode, overwrite, signal: ctx.signal,
                    names: { source: args.remotePath, target: args.localPath },
                });
                details.bytes = copied.bytes;
                if (!copied.modeSet) details.modeSet = false;
                return textResult(copiedText(args.remotePath, args.localPath, copied));
            } finally {
                agent?.close();
                target.close();
            }
        },
    });
};

module.exports = {
    put: { def: defOf(PUT), handler: putHandler, needsBrowser: false },
    get: { def: defOf(GET), handler: getHandler, needsBrowser: false },
    _copy: copy,
};

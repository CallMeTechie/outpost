const { OP, cancelAllTransfers } = require("./sftpWS");
const { authenticateToken } = require("../middlewares/wsAuth");
const MicrosoftConnection = require("../models/MicrosoftConnection");
const { requireOwnConnection, resolveSource, resolveDestination } = require("../lib/fileTransfer/endpoints");
const { graph } = require("../lib/microsoft/graphClient");
const { createOneDriveAdapter } = require("../lib/microsoft/oneDriveAdapter");
const { buildTransferHandlers } = require("../lib/fileTransfer/transferHandlers");
const { authorizeSource, authorizeDestination } = require("../lib/fileTransfer/transferAuth");
const { createEngineSftpAdapter } = require("../lib/fileTransfer/engineSftpAdapter");
const { FileTransfer } = require("../lib/fileTransfer/FileTransfer");
const registry = require("../lib/fileTransfer/registry");
const SessionManager = require("../lib/SessionManager");
const {
    getSFTPCrossTransferClient,
    releaseSFTPCrossTransferClient,
} = require("../lib/ConnectionService");
const Entry = require("../models/Entry");
const { resolveEntryScope, validateEntryAccess } = require("../controllers/entry");
const { hasResourcePermission } = require("../utils/permission");
const { getCapabilities } = require("../lib/fileCapabilities");
const { createAuditLog } = require("../controllers/audit");

// Everything a drive without a shell and without POSIX permissions can answer. The pane hides what
// is missing; offering a handler that cannot work would be worse than offering none.
const ONEDRIVE_OPS = new Set([
    OP.LIST_FILES, OP.STAT, OP.CREATE_FOLDER, OP.DELETE_FILE, OP.DELETE_FOLDER, OP.RENAME_FILE,
    OP.MOVE_FILES, OP.COPY_FILES,
]);

// A move or copy from the pane names a batch of source paths and a single destination folder.
const MAX_PANE_PATHS = 256;

const requirePathList = (payload) => {
    const paths = payload?.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PANE_PATHS) {
        throw new Error("A list of paths is required");
    }
    if (paths.some((p) => typeof p !== "string" || p === "")) throw new Error("A list of paths is required");
    return paths;
};

const requirePath = (payload) => {
    const path = payload?.path;
    if (typeof path !== "string" || path === "") throw new Error("A path is required");
    return path;
};

const requireName = (payload) => {
    const name = payload?.name;
    if (typeof name !== "string" || name === "" || name.includes("/") || name === "." || name === "..") {
        throw new Error("A name is required and must not contain a separator");
    }
    return name;
};

const joinPath = (parent, name) => `${parent.replace(/\/+$/, "")}/${name}`;

// Exported so the guard itself can be tested: an unguarded throw here escapes the async message
// listener as an unhandled rejection, and this codebase turns that into process.exit(1).
const createSend = (ws) => (opCode, data) => {
    if (ws.readyState !== 1) return;

    try {
        ws.send(Buffer.concat([Buffer.from([opCode]), Buffer.from(JSON.stringify(data))]));
    } catch { /* the socket went away between the check and the write */ }
};

// Extracted so the socket's two security properties — a strict id and the ownership question —
// can be tested without a WebSocket, and so the ownership check itself is the SAME one
// `resolveSource`/`resolveDestination` use in endpoints.js, not a second copy that can drift from
// it (the earlier version reimplemented it inline and lost the try/catch around a database error,
// which would otherwise reject out of the route and take the process down with it).
//
// The two failure shapes stay distinguishable on purpose: a malformed id is a client bug (4008),
// while "not owned" must stay byte-identical whether the connection is missing, foreign,
// disconnected, or the database itself failed (4403) — that uniformity is what stops the id from
// becoming a probe for someone else's account.
const resolveSocketConnection = async (rawConnectionId, user, deps = {}) => {
    const loadConnection = deps.loadConnection ?? ((id) => MicrosoftConnection.findOne({ where: { id } }));

    // As strict as parseEndpoint, and for the same reason: parseInt would accept "7abc" and " 7 "
    // and silently mean 7. The same conceptual field must not have two validation boundaries.
    if (!/^[1-9]\d*$/.test(rawConnectionId ?? "")) {
        return { ok: false, code: 4008, reason: "Invalid connection ID" };
    }

    const connectionId = Number(rawConnectionId);

    try {
        await requireOwnConnection({ loadConnection }, user, connectionId);
    } catch {
        return { ok: false, code: 4403, reason: "This Microsoft connection is not available" };
    }

    return { ok: true, connectionId };
};

const buildOneDriveHandlers = (op, { adapter, send }) => ({
    [op.LIST_FILES]: async (payload) => {
        const path = requirePath(payload);
        send(op.LIST_FILES, { path, files: await adapter.listDir(path) });
    },
    [op.STAT]: async (payload) => {
        const path = requirePath(payload);
        send(op.STAT, { path, ...(await adapter.stat(path)) });
    },
    [op.CREATE_FOLDER]: async (payload) => {
        const path = requirePath(payload);
        const name = requireName(payload);
        await adapter.mkdirRecursive(joinPath(path, name));
        send(op.CREATE_FOLDER, { path: joinPath(path, name) });
    },
    [op.DELETE_FILE]: async (payload) => {
        const path = requirePath(payload);
        await adapter.unlink(path);
        send(op.DELETE_FILE, { path });
    },
    [op.DELETE_FOLDER]: async (payload) => {
        const path = requirePath(payload);
        // The pane's delete means "this folder and what is in it"; the non-recursive form exists
        // for the transfer's move cleanup, not for a person clicking a bin.
        await adapter.rmdir(path, true);
        send(op.DELETE_FOLDER, { path });
    },
    [op.RENAME_FILE]: async (payload) => {
        const path = requirePath(payload);
        const name = requireName(payload);
        await adapter.rename(path, name);
        send(op.RENAME_FILE, { path, name });
    },
    [op.MOVE_FILES]: async (payload) => {
        const target = requirePath(payload);
        for (const path of requirePathList(payload)) await adapter.move(path, target);
        send(op.MOVE_FILES, { path: target });
    },
    [op.COPY_FILES]: async (payload) => {
        const target = requirePath(payload);
        for (const path of requirePathList(payload)) await adapter.copy(path, target);
        send(op.COPY_FILES, { path: target });
    },
});

module.exports = async (ws, req) => {
    const auth = await authenticateToken(ws, req.query?.sessionToken);
    if (!auth) return;

    // The one question a OneDrive endpoint asks — and it is answered before anything else happens,
    // so a foreign id learns nothing beyond that it was refused.
    const resolved = await resolveSocketConnection(req.query?.connectionId, auth.user);
    if (!resolved.ok) {
        ws.close(resolved.code, resolved.reason);
        return;
    }
    const { connectionId } = resolved;

    const adapter = createOneDriveAdapter({ graph, connectionId });
    const send = createSend(ws);

    // This socket's own endpoint — the side a transfer arriving here writes into.
    const endpoint = { kind: "onedrive", connectionId, driveId: "me" };
    const transfers = new Map();

    const authDeps = {
        getSession: SessionManager.get,
        getConnection: SessionManager.getConnection,
        findEntry: (id) => Entry.findByPk(id),
        resolveEntryScope, validateEntryAccess, hasResourcePermission,
    };
    // A OneDrive socket has no session and no entry, so the sftp half of endpointDeps is never
    // reached from here — but a transfer whose SOURCE is a server does reach it, which is why the
    // whole set is wired rather than only the OneDrive half.
    const endpointDeps = {
        authorizeSource: (request) => authorizeSource(authDeps, request),
        authorizeDestination: (request) => authorizeDestination(authDeps, request),
        getConnection: SessionManager.getConnection,
        findEntry: (id) => Entry.findByPk(id),
        getCrossClient: getSFTPCrossTransferClient,
        releaseCrossClient: releaseSFTPCrossTransferClient,
        createSftpAdapter: createEngineSftpAdapter,
        getCapabilities,
        loadConnection: (id) => MicrosoftConnection.findOne({ where: { id } }),
        createOneDriveAdapter: ({ connectionId: id }) => createOneDriveAdapter({ graph, connectionId: id }),
    };

    const transferHandlers = buildTransferHandlers(OP, {
        user: auth.user, endpoint, transfers,
        ipAddress: req.ip, userAgent: req.headers?.["user-agent"],
        deps: {
            send,
            registry,
            findEntry: (id) => Entry.findByPk(id),
            resolveSource: (request) => resolveSource(endpointDeps, request),
            resolveDestination: (request) => resolveDestination(endpointDeps, request),
            createTransfer: (opts) => new FileTransfer(opts),
            createAuditLog,
        },
    });

    const handlers = buildOneDriveHandlers(OP, { adapter, send, connectionId });

    send(OP.READY, { path: "/", capabilities: { shell: false, checksum: false } });

    ws.on("message", async (msg) => {
        let payload;
        try { payload = JSON.parse(msg.slice(1).toString()); } catch { payload = undefined; }

        try {
            // The three transfer opcodes are deliberately NOT part of the handler table:
            // buildTransferHandlers answers with { start, cancel, resolve } rather than an
            // opcode-indexed map, and ONEDRIVE_OPS names exactly what that table offers. They hang
            // in the dispatch itself, the way sftpWS.js does it.
            if (msg[0] === OP.TRANSFER_START) return void await transferHandlers.start(payload);
            if (msg[0] === OP.TRANSFER_CANCEL) return void await transferHandlers.cancel(payload);
            if (msg[0] === OP.TRANSFER_RESOLVE) return void await transferHandlers.resolve(payload);

            const handler = handlers[msg[0]];
            if (!handler) return;

            await handler(payload);
        } catch (error) {
            send(OP.ERROR, { message: error.message || "Operation failed" });
        }
    });

    ws.on("close", () => {
        // A socket that goes away must not leave a transfer running against a destination nobody
        // is watching any more.
        cancelAllTransfers(transfers);
    });
};

module.exports.buildOneDriveHandlers = buildOneDriveHandlers;
module.exports.ONEDRIVE_OPS = ONEDRIVE_OPS;
module.exports.resolveSocketConnection = resolveSocketConnection;
module.exports.createSend = createSend;

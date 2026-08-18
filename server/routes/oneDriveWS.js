const { OP, cancelAllTransfers } = require("./sftpWS");
const { authenticateToken } = require("../middlewares/wsAuth");
const MicrosoftConnection = require("../models/MicrosoftConnection");
const { requireOwnConnection, resolveSource, resolveDestination } = require("../lib/fileTransfer/endpoints");
const { graph } = require("../lib/microsoft/graphClient");
const { createOneDriveAdapter } = require("../lib/microsoft/oneDriveAdapter");
const { MicrosoftDisconnectedError } = require("../lib/microsoft/errors");
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

const loadConnection = (id) => MicrosoftConnection.findOne({ where: { id } });

// Everything a drive without a shell and without POSIX permissions can answer. The pane hides what
// is missing; offering a handler that cannot work would be worse than offering none.
//
// Pinned against the handler table by a test so the two cannot drift. It is a fixture, not a gate:
// the dispatch decides on the table itself.
const ONEDRIVE_OPS = new Set([
    OP.LIST_FILES, OP.STAT, OP.CREATE_FOLDER, OP.DELETE_FILE, OP.DELETE_FOLDER, OP.RENAME_FILE,
    OP.MOVE_FILES, OP.COPY_FILES,
]);

// A move or copy from the pane names a batch of source paths and a single destination folder.
const MAX_PANE_PATHS = 256;

// The fields below are the pane's, not this socket's. The file manager has always spoken the
// vocabulary sftpWS.js understands, and a pane that sent different fields depending on the provider
// would be exactly the provider-specific knowledge it is built without — so the server adapts.
// client/.../FileRenderer/utils/paneRequests.js is the other half of this seam, and
// oneDrivePaneSeam.test.js drives one into the other.
const requireSources = (payload) => {
    const sources = payload?.sources;
    if (!Array.isArray(sources) || sources.length === 0 || sources.length > MAX_PANE_PATHS) {
        throw new Error("A list of sources is required");
    }
    if (sources.some((p) => typeof p !== "string" || p === "")) throw new Error("A list of sources is required");
    return sources;
};

const requirePath = (payload) => {
    const path = payload?.path;
    if (typeof path !== "string" || path === "") throw new Error("A path is required");
    return path;
};

const requireDestination = (payload) => {
    const destination = payload?.destination;
    if (typeof destination !== "string" || destination === "") throw new Error("A destination is required");
    return destination;
};

// The two seams below this socket read a directory entry differently. The transfer seam names the
// date `mtime` — that is what oneDriveAdapter and engineSftpAdapter both report, and it is in
// production, so it stays. The pane reads `last_modified`, the name EngineSftpClient hands it.
// Translating here rather than in the adapter keeps the transfer seam untouched; without it every
// row in the pane rendered "Invalid Date".
//
// `mode` is absent on purpose: OneDrive has no POSIX permissions, and the pane hides the column
// for a provider without a native file system rather than inventing one.
const toPaneEntry = (entry) => ({
    name: entry.name,
    type: entry.type,
    size: entry.size,
    isSymlink: entry.isSymlink,
    last_modified: entry.mtime,
});

const requireName = (name) => {
    if (typeof name !== "string" || name === "" || name.includes("/") || name === "." || name === "..") {
        throw new Error("A name is required and must not contain a separator");
    }
    return name;
};

// Graph renames by name, the pane renames by target path. The last segment is the new name, and it
// has to survive the same check a name given directly would: "/a/" or "/a/.." must not reach Graph.
const requireNewName = (payload) => {
    const newPath = payload?.newPath;
    if (typeof newPath !== "string") throw new Error("A new path is required");
    return requireName(newPath.split("/").pop());
};

// Exported so the guard itself can be tested: an unguarded throw here escapes the async message
// listener as an unhandled rejection, and this codebase turns that into process.exit(1).
const createSend = (ws) => (opCode, data) => {
    if (ws.readyState !== 1) return;

    try {
        ws.send(Buffer.concat([Buffer.from([opCode]), Buffer.from(JSON.stringify(data))]));
    } catch { /* the socket went away between the check and the write */ }
};

// Guarded for the same reason createSend is: it runs inside the async message listener.
const createClose = (ws) => (code, reason) => {
    if (ws.readyState !== 1) return;

    try {
        ws.close(code, reason);
    } catch { /* the socket went away between the check and the close */ }
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
    // As strict as parseEndpoint, and for the same reason: parseInt would accept "7abc" and " 7 "
    // and silently mean 7. The same conceptual field must not have two validation boundaries.
    if (!/^[1-9]\d*$/.test(rawConnectionId ?? "")) {
        return { ok: false, code: 4008, reason: "Invalid connection ID" };
    }

    const connectionId = Number(rawConnectionId);

    try {
        await requireOwnConnection({ loadConnection: deps.loadConnection ?? loadConnection }, user, connectionId);
    } catch {
        return { ok: false, code: 4403, reason: "This Microsoft connection is not available" };
    }

    return { ok: true, connectionId };
};

// Deliberately unaudited, unlike every mutating operation on the SFTP socket. Outpost's audit trail
// records what touches Outpost's resources: a server is a shared resource, a personal OneDrive is
// not. That is also why a transfer started from this socket IS audited — it moves data onto or off
// a server — while a rename inside somebody's own drive is not Outpost's business to record.
const buildOneDriveHandlers = (op, { adapter, send }) => ({
    [op.LIST_FILES]: async (payload) => {
        const path = requirePath(payload);
        send(op.LIST_FILES, { path, files: (await adapter.listDir(path)).map(toPaneEntry) });
    },
    [op.STAT]: async (payload) => {
        const path = requirePath(payload);
        send(op.STAT, { path, ...(await adapter.stat(path)) });
    },
    [op.CREATE_FOLDER]: async (payload) => {
        // The pane names the new folder by its full path, so the parent may not exist either — a
        // drop of an empty folder tree asks for the whole chain at once.
        const path = requirePath(payload);
        await adapter.mkdirRecursive(path);
        send(op.CREATE_FOLDER, { path });
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
        const name = requireNewName(payload);
        await adapter.rename(path, name);
        send(op.RENAME_FILE, { path, newPath: payload.newPath });
    },
    [op.MOVE_FILES]: async (payload) => {
        const destination = requireDestination(payload);
        const sources = requireSources(payload);
        for (const source of sources) await adapter.move(source, destination);
        send(op.MOVE_FILES, { sources, destination });
    },
    [op.COPY_FILES]: async (payload) => {
        const destination = requireDestination(payload);
        const sources = requireSources(payload);
        for (const source of sources) await adapter.copy(source, destination);
        send(op.COPY_FILES, { sources, destination });
    },
});

// Exported so the dispatch itself can be tested without a socket. The three transfer opcodes are
// deliberately NOT in the handler table: buildTransferHandlers returns { start, cancel, resolve },
// a different shape, and ONEDRIVE_OPS is pinned against the table by a test.
//
// The payload is parsed before the opcode decision, not after the table lookup: the three transfer
// branches need it too, and an unknown opcode leaving without a parse would have to duplicate it.
const createMessageDispatch = ({ handlers, transferHandlers, send, close }) => async (msg) => {
    let payload;
    try { payload = JSON.parse(msg.slice(1).toString()); } catch { payload = undefined; }

    try {
        if (msg[0] === OP.TRANSFER_START) return void await transferHandlers.start(payload);
        if (msg[0] === OP.TRANSFER_CANCEL) return void await transferHandlers.cancel(payload);
        if (msg[0] === OP.TRANSFER_RESOLVE) return void await transferHandlers.resolve(payload);

        const handler = handlers[msg[0]];
        if (!handler) return;

        await handler(payload);
    } catch (error) {
        // Consent withdrawn is not an operation that failed — the socket cannot serve anything any
        // more, and every further request would fail the same way with an untranslated English
        // toast. 4403 is the one close code the pane turns into the message that names the account
        // page, and it is the same code a fresh connection attempt would be refused with: both
        // routes to a disconnected account say the same thing, which is what the pane promises.
        if (error instanceof MicrosoftDisconnectedError) {
            close(4403, "This Microsoft connection is not available");
            return;
        }
        send(OP.ERROR, { message: error.message || "Operation failed" });
    }
};

// A socket that goes away must not leave a transfer running against a destination nobody is
// watching any more. Exported for the same reason as the dispatch: a close handler registered
// inline is invisible to every test, and this one silently stops working if it is ever dropped.
const createCloseHandler = (transfers) => () => cancelAllTransfers(transfers);

// Same vocabulary as fileCapabilities.getCapabilities — pinned by a test, because the previous
// version of this line answered with `checksum` (which nothing reads) and omitted `terminal`
// (which several menus do). OneDrive has no shell and no terminal, but COPY_FILES is a Graph
// call and belongs to ONEDRIVE_OPS, so `copy` is true. `nativeFs` is false: no empty files, no
// directory completion, no symbolic links, no POSIX permissions behind a drive.
//
// `content` is false until a drive has download and upload routes of its own: the ones the pane
// uses are keyed by an SFTP session, and a drive has none. It is a word rather than a silence
// because the four controls behind it are built and wired — flipping this to true is all they need.
const ONEDRIVE_CAPABILITIES = { shell: false, terminal: false, copy: true, nativeFs: false, content: true };

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
        getCrossClient: getSFTPCrossTransferClient,
        releaseCrossClient: releaseSFTPCrossTransferClient,
        createSftpAdapter: createEngineSftpAdapter,
        getCapabilities,
        loadConnection,
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

    const handlers = buildOneDriveHandlers(OP, { adapter, send });

    send(OP.READY, { path: "/", capabilities: ONEDRIVE_CAPABILITIES });

    ws.on("message", createMessageDispatch({ handlers, transferHandlers, send, close: createClose(ws) }));

    ws.on("close", createCloseHandler(transfers));
};

module.exports.buildOneDriveHandlers = buildOneDriveHandlers;
module.exports.ONEDRIVE_OPS = ONEDRIVE_OPS;
module.exports.ONEDRIVE_CAPABILITIES = ONEDRIVE_CAPABILITIES;
module.exports.resolveSocketConnection = resolveSocketConnection;
module.exports.createSend = createSend;
module.exports.createClose = createClose;
module.exports.createMessageDispatch = createMessageDispatch;
module.exports.createCloseHandler = createCloseHandler;

const { OP } = require("./sftpWS");
const { authenticateToken } = require("../middlewares/wsAuth");
const MicrosoftConnection = require("../models/MicrosoftConnection");
const { graph } = require("../lib/microsoft/graphClient");
const { createOneDriveAdapter } = require("../lib/microsoft/oneDriveAdapter");
const logger = require("../utils/logger");

// Everything a drive without a shell and without POSIX permissions can answer. The pane hides what
// is missing; offering a handler that cannot work would be worse than offering none.
const ONEDRIVE_OPS = new Set([
    OP.LIST_FILES, OP.STAT, OP.CREATE_FOLDER, OP.DELETE_FILE, OP.DELETE_FOLDER, OP.RENAME_FILE,
]);

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
});

module.exports = async (ws, req) => {
    const auth = await authenticateToken(ws, req.query?.sessionToken);
    if (!auth) return;

    // As strict as parseEndpoint, and for the same reason: parseInt would accept "7abc" and " 7 "
    // and silently mean 7. The same conceptual field must not have two validation boundaries.
    const raw = req.query?.connectionId ?? "";
    const connectionId = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(connectionId) || connectionId <= 0) {
        ws.close(4008, "Invalid connection ID");
        return;
    }

    // The one question a OneDrive endpoint asks — and it is answered before anything else happens,
    // so a foreign id learns nothing beyond that it was refused.
    const connection = await MicrosoftConnection.findOne({ where: { id: connectionId } });
    if (!connection || connection.accountId !== auth.user.id || connection.status !== "connected") {
        ws.close(4403, "This Microsoft connection is not available");
        return;
    }

    const adapter = createOneDriveAdapter({ graph, connectionId });
    const send = (opCode, data) => {
        if (ws.readyState !== 1) return;
        ws.send(Buffer.concat([Buffer.from([opCode]), Buffer.from(JSON.stringify(data))]));
    };

    const handlers = buildOneDriveHandlers(OP, { adapter, send, connectionId });

    send(OP.READY, { path: "/", capabilities: { shell: false, checksum: false } });

    ws.on("message", async (msg) => {
        const handler = handlers[msg[0]];
        if (!handler) return;

        let payload;
        try { payload = JSON.parse(msg.slice(1).toString()); } catch { payload = undefined; }

        try {
            await handler(payload);
        } catch (error) {
            send(OP.ERROR, { message: error.message || "Operation failed" });
        }
    });

    ws.on("close", () => logger.debug?.("OneDrive websocket closed", { connectionId }));
};

module.exports.buildOneDriveHandlers = buildOneDriveHandlers;
module.exports.ONEDRIVE_OPS = ONEDRIVE_OPS;

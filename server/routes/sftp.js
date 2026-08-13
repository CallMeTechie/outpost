const { Router } = require("express");
const express = require("express");
const Session = require("../models/Session");
const Account = require("../models/Account");
const SessionManager = require("../lib/SessionManager");
const { getSFTPTransferClient } = require("../lib/ConnectionService");
const Entry = require("../models/Entry");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("../controllers/audit");
const { hasResourcePermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const logger = require("../utils/logger");
const { ZipArchive } = require("archiver");
const { createEngineSftpAdapter } = require("../lib/fileTransfer/engineSftpAdapter");
const { archiveFolder, archiveItems } = require("../lib/fileContent/archive");
const {
    THUMB_EXTS, MAX_THUMB_SIZE,
    getExt, getFileName, sanitizeFileName, clampThumbSize, contentHeaders, sendFile,
} = require("../lib/fileContent/download");

const app = Router();

const handleError = (res, err) => {
    if (res.headersSent) return;
    const msg = err.message || "Internal error";
    if (msg.includes("does not exist")) return res.status(404).json({ error: "Not found" });
    if (msg.includes("Permission denied")) return res.status(403).json({ error: "Permission denied" });
    res.status(500).json({ error: msg });
};

const checkFilePermission = (ctx, permission) =>
    hasResourcePermission(ctx.user.id, ctx.entry.organizationId, permission);

const audit = (ctx, req, action, resource, details) => {
    createAuditLog({
        accountId: ctx.user.id, organizationId: ctx.entry.organizationId,
        action, resource, details, ipAddress: req.ip, userAgent: req.headers["user-agent"],
    });
};

const validateSession = async (sessionToken, sessionId) => {
    const session = await Session.findOne({ where: { token: sessionToken } });
    if (!session) return { error: "Invalid session", status: 401 };

    const [user, serverSession] = await Promise.all([
        Account.findByPk(session.accountId),
        Session.update({ lastActivity: new Date() }, { where: { id: session.id } }).then(() => SessionManager.get(sessionId)),
    ]);

    if (!user) return { error: "User not found", status: 401 };
    if (!serverSession) return { error: "Session not found", status: 404 };
    if (serverSession.accountId !== user.id) return { error: "Unauthorized", status: 403 };

    const entry = await Entry.findByPk(serverSession.entryId);
    if (!entry) return { error: "Entry not found", status: 404 };

    const conn = SessionManager.getConnection(sessionId);
    if (!conn?.sftpClient) return { error: "No active SFTP connection", status: 400 };

    let sftpClient = conn.sftpClient;
    try {
        sftpClient = await getSFTPTransferClient(sessionId, entry, user.id);
    } catch (err) {
        logger.warn("Falling back to metadata SFTP client for transfer", { sessionId, error: err.message });
    }

    // This client is not exclusive to this request: it is cached per session (getSFTPTransferClient)
    // and, on that call failing, falls back to the connection's own shared metadata client. Either
    // one may be serving a concurrent download or the file browser's directory listing at the same
    // moment, so the adapter must not pause the whole client while a slow HTTP peer is behind on
    // this response — see engineSftpAdapter.js's readFile for what backpressure:true would do here.
    return {
        session, user, serverSession, entry, sftpClient,
        adapter: createEngineSftpAdapter(sftpClient, undefined, { backpressure: false }),
    };
};

const validateRequest = (query) => {
    const { sessionToken, sessionId, path: remotePath } = query;
    if (!sessionToken || !sessionId || !remotePath) return "Missing parameters";
    if (remotePath.split("/").includes("..")) return "Invalid path";
    return null;
};

/**
 * POST /sftp/upload
 * @summary Upload File via SFTP
 * @description Uploads a file to a remote server via SFTP. The file content should be sent as the raw request body. Missing parent directories are created when the user is allowed to modify files. Requires an active session with SFTP capabilities.
 * @tags SFTP
 * @produces application/json
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {string} path.query.required - Remote destination path for the uploaded file
 * @return {object} 200 - Upload successful with file path and size
 * @return {object} 400 - Missing parameters or invalid path
 * @return {object} 401 - Invalid session token
 * @return {object} 403 - Permission denied
 * @return {object} 404 - Session or entry not found
 * @return {object} 500 - Upload error
 */
app.post("/upload", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { sessionToken, sessionId, path: remotePath } = req.query;

    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        if (!(await checkFilePermission(ctx, Permission.FILES_UPLOAD)))
            return res.status(403).json({ error: "You don't have permission to upload files" });

        const parentPath = remotePath.substring(0, remotePath.lastIndexOf("/"));
        if (parentPath && await checkFilePermission(ctx, Permission.FILES_MODIFY)) {
            const created = await ctx.sftpClient.mkdirRecursive(parentPath);
            for (const folderPath of created)
                audit(ctx, req, AUDIT_ACTIONS.FOLDER_CREATE, RESOURCE_TYPES.FOLDER, { folderPath });
        }

        await ctx.sftpClient.writeFile(remotePath, req);

        const totalSize = Number.parseInt(req.headers["content-length"]) || 0;
        res.json({ success: true, path: remotePath, size: totalSize });
        audit(ctx, req, AUDIT_ACTIONS.FILE_UPLOAD, RESOURCE_TYPES.FILE, { filePath: remotePath, fileSize: totalSize });
    } catch (err) {
        logger.error("Upload error", { error: err.message, path: remotePath });
        handleError(res, err);
    }
});

/**
 * GET /sftp
 * @summary Download or Preview File via SFTP
 * @description Downloads a file or folder from a remote server via SFTP. Supports file preview, thumbnail generation for images, and folder download as ZIP archive.
 * @tags SFTP
 * @produces application/octet-stream
 * @produces application/zip
 * @produces image/jpeg
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {string} path.query.required - Remote file or folder path to download
 * @param {string} preview.query - Set to "true" to display file inline instead of downloading
 * @param {string} thumbnail.query - Set to "true" to generate a thumbnail (images only, max 10MB)
 * @param {number} size.query - Thumbnail size in pixels (50-300, default: 100)
 * @return {file} 200 - File content, ZIP archive, or thumbnail image
 * @return {object} 400 - Missing parameters or invalid path
 * @return {object} 401 - Invalid session token
 * @return {object} 403 - Permission denied
 * @return {object} 404 - File, session, or entry not found
 * @return {object} 500 - Download error
 */
app.get("/", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { sessionToken, sessionId, path: remotePath, preview, thumbnail, size } = req.query;

    // Declared outside the try so the catch below can reach it: the ZIP branch's own `archive`
    // would otherwise be scoped to the try block and invisible where the abort actually happens.
    let archive;
    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        if (!(await checkFilePermission(ctx, Permission.FILES_DOWNLOAD)))
            return res.status(403).json({ error: "You don't have permission to download files" });

        const { sftpClient } = ctx;
        const stats = await sftpClient.stat(remotePath);
        const fileName = getFileName(remotePath);
        const safeFileName = sanitizeFileName(fileName);

        if (stats.isDir) {
            res.header("Content-Disposition", `attachment; filename="${safeFileName}.zip"`);
            res.header("Content-Type", "application/zip");
            archive = new ZipArchive({ zlib: { level: 1 } });
            archive.on("error", (err) => {
                logger.warn("Archive error", { error: err.message, path: remotePath });
                archive.abort();
            });
            res.on("close", () => archive.abort());
            archive.pipe(res);
            await archiveFolder(ctx.adapter, archive, remotePath, safeFileName);
            archive.finalize();
            audit(ctx, req, AUDIT_ACTIONS.FOLDER_DOWNLOAD, RESOURCE_TYPES.FOLDER, { folderPath: remotePath });
            return;
        }

        if (thumbnail === "true" && THUMB_EXTS.has(getExt(remotePath)) && stats.size <= MAX_THUMB_SIZE) {
            const thumbSize = clampThumbSize(size);
            const { data } = await sftpClient.thumbnail(remotePath, thumbSize);
            res.header("Content-Type", "image/jpeg");
            res.header("Cache-Control", "public, max-age=3600");
            res.end(data);
            return;
        }

        const ext = getExt(remotePath);
        const headers = contentHeaders({ fileName, size: stats.size, ext, preview: preview === "true" });
        for (const [name, value] of Object.entries(headers)) res.header(name, value);

        // Awaited so a throw from adapter.readFile lands in this function's own catch, the same as
        // every other synchronous throw here. Without it, sendFile's `async` turns that throw into
        // a rejection nothing here observes — and this process has no unhandledRejection handler,
        // only uncaughtException, so Node would tear down the whole server over one bad path.
        await sendFile(ctx.adapter, res, remotePath);
        audit(ctx, req, AUDIT_ACTIONS.FILE_DOWNLOAD, RESOURCE_TYPES.FILE, { filePath: remotePath, fileSize: stats.size });
    } catch (err) {
        // Once the headers are out there is no status code left to send, and archiver will never
        // idle after a source stream was destroyed — finalize() simply never returns. res.destroy()
        // is deliberate here and not res.end(): for a chunked response, end() would write the
        // terminating zero-length chunk and tell the browser the download finished — saving a ZIP
        // with no central directory as if it had succeeded. destroy() cuts the socket instead, so
        // the client sees the failure — either a reset with no status line at all if this fires
        // before anything was flushed, or a connection dropped mid-body if some already went out —
        // rather than a silently corrupt "complete" file or (the old behaviour) a spinner that never
        // ends. Deliberate behaviour change, see the plan's Global Constraints, the "response never
        // ends on a mid-archive failure" exception.
        if (res.headersSent) { archive?.abort(); res.destroy(); return; }
        handleError(res, err);
    }
});

/**
 * POST /sftp/multi
 * @summary Download Multiple Files via SFTP
 * @description Downloads multiple files and/or folders as a single ZIP archive. Supports mixed selection of files and folders. Failed items are skipped and logged.
 * @tags SFTP
 * @consumes application/x-www-form-urlencoded
 * @produces application/zip
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {object} request.body.required - Request body containing paths array
 * @return {file} 200 - ZIP archive containing all requested files and folders
 * @return {object} 400 - Missing parameters, invalid paths format, or no paths provided
 * @return {object} 401 - Invalid session token
 * @return {object} 403 - Permission denied
 * @return {object} 404 - Session or entry not found
 * @return {object} 500 - Download error
 */
app.post("/multi", express.urlencoded({ extended: true }), async (req, res) => {
    const { sessionToken, sessionId } = req.query;
    let { paths } = req.body;

    if (typeof paths === "string") {
        try { paths = JSON.parse(paths); }
        catch { return res.status(400).json({ error: "Invalid paths format" }); }
    }

    if (!sessionToken || !sessionId) return res.status(400).json({ error: "Missing session parameters" });
    if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: "No paths provided" });
    if (paths.some((p) => p.includes(".."))) return res.status(400).json({ error: "Invalid path" });

    // See the GET / handler for why this lives outside the try.
    let archive;
    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        if (!(await checkFilePermission(ctx, Permission.FILES_DOWNLOAD)))
            return res.status(403).json({ error: "You don't have permission to download files" });

        const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
        res.header("Content-Disposition", `attachment; filename="nexterm-download-${timestamp}.zip"`);
        res.header("Content-Type", "application/zip");

        archive = new ZipArchive({ zlib: { level: 5 } });
        archive.on("error", (err) => {
            logger.warn("Multi-download archive error", { error: err.message });
            archive.abort();
        });
        res.on("close", () => archive.abort());
        archive.pipe(res);

        await archiveItems(ctx.adapter, archive, paths);
        archive.finalize();

        audit(ctx, req, AUDIT_ACTIONS.FILE_DOWNLOAD, RESOURCE_TYPES.FILE, {
            paths,
            count: paths.length,
            connectionReason: ctx.serverSession.connectionReason || null,
        });
    } catch (err) {
        // Same rationale as GET / — see that handler's catch for why destroy() and not end(). The
        // archive.abort() here is a second call when `archive.on("error", ...)` already ran one; a
        // repeat abort on an aborted archiver is a no-op, so paying for the redundancy once here is
        // simpler than tracking "already aborted" state for this one path.
        if (res.headersSent) { archive?.abort(); res.destroy(); return; }
        handleError(res, err);
    }
});

module.exports = app;

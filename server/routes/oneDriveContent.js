// The three HTTP content routes for a OneDrive connection — same job as sftp.js, same shared
// fileContent module underneath, different adapter and a different way of proving who is asking.
// sftp.js resolves a server session; this file resolves a Microsoft connection, so the two routes
// read alike everywhere the seam is doing the work and differ only where OneDrive itself differs:
// no session, no organization-scoped permission to check (a personal drive is not a shared
// resource — see oneDriveWS.js), and errors that arrive from Graph rather than from an SFTP client.
const { Router } = require("express");
const express = require("express");
const logger = require("../utils/logger");
const { ZipArchive } = require("archiver");
const { graph } = require("../lib/microsoft/graphClient");
const { createOneDriveAdapter } = require("../lib/microsoft/oneDriveAdapter");
const { resolveSocketConnection } = require("./oneDriveWS");
const { resolveSessionToken } = require("../middlewares/wsAuth");
const { archiveFolder, archiveItems } = require("../lib/fileContent/archive");
const {
    THUMB_EXTS, MAX_THUMB_SIZE,
    getExt, getFileName, sanitizeFileName, clampThumbSize, contentHeaders, sendFile,
} = require("../lib/fileContent/download");

const app = Router();

// Every content route asks the same three questions before it does anything: who is this, which
// connection, and may they have it. resolveSocketConnection already answers the last two for the
// WebSocket — the only thing that differs here is that a refusal becomes a status code instead of
// a close code. Exported as a pure mapping (not baked into resolveRequest) so it can be tested
// without a request at all.
const CLOSE_TO_STATUS = { 4008: 400, 4403: 403 };
const closeCodeToStatus = (code) => CLOSE_TO_STATUS[code] ?? 400;

// wsAuth.js's authenticateToken closes a socket on failure; an HTTP route has no socket to close
// and every failure shape here becomes the same 401 — resolveSessionToken's close code is simply
// not read. That is the whole adapter: no second identity check growing beside the socket's.
const authenticateHttpToken = async (sessionToken) => {
    const result = await resolveSessionToken(sessionToken);
    return result.ok ? { session: result.session, user: result.user } : null;
};

const resolveRequest = async (req, res) => {
    const auth = await authenticateHttpToken(req.query?.sessionToken);
    if (!auth) {
        res.status(401).json({ error: "Invalid session" });
        return null;
    }

    const resolved = await resolveSocketConnection(req.query?.connectionId, auth.user);
    if (!resolved.ok) {
        res.status(closeCodeToStatus(resolved.code)).json({ error: resolved.reason });
        return null;
    }

    return {
        user: auth.user,
        adapter: createOneDriveAdapter({ graph, connectionId: resolved.connectionId }),
    };
};

const validateRequest = (query) => {
    const { path: remotePath } = query;
    if (!remotePath) return "Missing parameters";
    if (remotePath.split("/").includes("..")) return "Invalid path";
    return null;
};

// GraphError already carries both halves of what a caller needs: describeGraphFailure
// (graphErrors.js) chose the sentence — Microsoft's own text for anything it has no wording of its
// own for, its own wording for the statuses it names specially, "does not exist" among them — and
// graphClient's request() copied Graph's own status onto the error alongside it. Forwarding both
// straight through, instead of re-deriving a status from a substring match the way sftp.js's
// handleError does for a plain Error, is what keeps that sentence attached to the code a browser
// actually reacts to.
const handleGraphError = (res, err) => {
    if (res.headersSent) return;
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: err?.message || "OneDrive request failed" });
};

/**
 * POST /entries/onedrive/upload
 * @summary Upload File to OneDrive
 * @description Uploads a file to a OneDrive connection. The file content is streamed straight from the request body. Requires a Content-Length header up front, since Graph's chunked upload needs the total size before the first byte moves.
 * @tags OneDrive
 * @produces application/json
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} connectionId.query.required - Microsoft connection ID
 * @param {string} path.query.required - Destination path within the OneDrive drive
 * @return {object} 200 - Upload successful with file path and size
 * @return {object} 400 - Missing parameters, invalid path, or the connection ID is malformed
 * @return {object} 401 - Invalid session token
 * @return {object} 403 - The connection does not belong to this account
 * @return {object} 411 - No Content-Length header was sent
 * @return {object} 500 - Upload error
 */
app.post("/upload", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { path: remotePath } = req.query;

    try {
        const ctx = await resolveRequest(req, res);
        if (!ctx) return;

        const size = Number.parseInt(req.headers["content-length"]);
        // oneDriveUpload picks the chunked path by size and needs the total up front for Graph's
        // Content-Range. Without the header there is nothing to pick by, and starting anyway would
        // fail somewhere in the middle of the stream instead of here.
        if (!Number.isInteger(size)) return res.status(411).json({ error: "A content length is required" });

        await ctx.adapter.writeFile(remotePath, req, { size });

        res.json({ success: true, path: remotePath, size });
    } catch (err) {
        logger.error("OneDrive upload error", { error: err.message, path: remotePath });
        handleGraphError(res, err);
    }
});

/**
 * GET /entries/onedrive
 * @summary Download or Preview a OneDrive Item
 * @description Downloads a file or folder from a OneDrive connection. Supports file preview, thumbnail generation for images, and folder download as a ZIP archive.
 * @tags OneDrive
 * @produces application/octet-stream
 * @produces application/zip
 * @produces image/jpeg
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} connectionId.query.required - Microsoft connection ID
 * @param {string} path.query.required - Path of the file or folder within the drive
 * @param {string} preview.query - Set to "true" to display file inline instead of downloading
 * @param {string} thumbnail.query - Set to "true" to generate a thumbnail (images only, max 10MB)
 * @param {number} size.query - Thumbnail size in pixels (50-300, default: 100)
 * @return {file} 200 - File content, ZIP archive, or thumbnail image
 * @return {object} 400 - Missing parameters, invalid path, or the connection ID is malformed
 * @return {object} 401 - Invalid session token
 * @return {object} 403 - The connection does not belong to this account
 * @return {object} 404 - The item does not exist
 * @return {object} 500 - Download error
 */
app.get("/", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { path: remotePath, preview, thumbnail, size } = req.query;

    // Declared outside the try so the catch below can reach it — the ZIP branch's own `archive`
    // would otherwise be scoped to the try block and invisible where the abort actually happens.
    // Same structure as sftp.js's GET / for the same reason.
    let archive;
    try {
        const ctx = await resolveRequest(req, res);
        if (!ctx) return;

        const stats = await ctx.adapter.stat(remotePath);
        const fileName = getFileName(remotePath);
        const safeFileName = sanitizeFileName(fileName);

        if (stats.type === "folder") {
            res.header("Content-Disposition", `attachment; filename="${safeFileName}.zip"`);
            res.header("Content-Type", "application/zip");
            archive = new ZipArchive({ zlib: { level: 1 } });
            archive.on("error", (err) => {
                logger.warn("OneDrive archive error", { error: err.message, path: remotePath });
                archive.abort();
            });
            res.on("close", () => archive.abort());
            archive.pipe(res);
            await archiveFolder(ctx.adapter, archive, remotePath, safeFileName);
            archive.finalize();
            return;
        }

        if (thumbnail === "true" && THUMB_EXTS.has(getExt(remotePath)) && stats.size <= MAX_THUMB_SIZE) {
            const thumbSize = clampThumbSize(size);
            const { data, contentType } = await ctx.adapter.thumbnail(remotePath, thumbSize);
            res.header("Content-Type", contentType);
            res.header("Cache-Control", "public, max-age=3600");
            res.end(data);
            return;
        }

        const ext = getExt(remotePath);
        const headers = contentHeaders({ fileName, size: stats.size, ext, preview: preview === "true" });
        for (const [name, value] of Object.entries(headers)) res.header(name, value);

        // Awaited so a throw from adapter.readFile lands in this function's own catch, the same as
        // every other synchronous throw here — see sftp.js's GET / for why this matters: without
        // it, sendFile's `async` would turn the throw into a rejection nothing here observes.
        await sendFile(ctx.adapter, res, remotePath);
    } catch (err) {
        // Same rationale as sftp.js's GET / catch: once the headers are out there is no status
        // left to send, and archiver never idles after its source stream was destroyed. destroy()
        // cuts the socket instead of end()'ing a chunked response that would otherwise look like a
        // complete, valid ZIP with no central directory. See sftp.js for the full explanation.
        if (res.headersSent) { archive?.abort(); res.destroy(); return; }
        handleGraphError(res, err);
    }
});

/**
 * POST /entries/onedrive/multi
 * @summary Download Multiple OneDrive Items
 * @description Downloads multiple files and/or folders from a OneDrive connection as a single ZIP archive. Failed items are skipped and logged.
 * @tags OneDrive
 * @consumes application/x-www-form-urlencoded
 * @produces application/zip
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} connectionId.query.required - Microsoft connection ID
 * @param {object} request.body.required - Request body containing paths array
 * @return {file} 200 - ZIP archive containing all requested files and folders
 * @return {object} 400 - Missing parameters, invalid paths format, or no paths provided
 * @return {object} 401 - Invalid session token
 * @return {object} 403 - The connection does not belong to this account
 * @return {object} 500 - Download error
 */
app.post("/multi", express.urlencoded({ extended: true }), async (req, res) => {
    let { paths } = req.body;

    if (typeof paths === "string") {
        try { paths = JSON.parse(paths); }
        catch { return res.status(400).json({ error: "Invalid paths format" }); }
    }

    if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: "No paths provided" });
    if (paths.some((p) => typeof p !== "string" || p.includes(".."))) return res.status(400).json({ error: "Invalid path" });

    // See the GET / handler for why this lives outside the try.
    let archive;
    try {
        const ctx = await resolveRequest(req, res);
        if (!ctx) return;

        const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
        res.header("Content-Disposition", `attachment; filename="nexterm-download-${timestamp}.zip"`);
        res.header("Content-Type", "application/zip");

        archive = new ZipArchive({ zlib: { level: 5 } });
        archive.on("error", (err) => {
            logger.warn("OneDrive multi-download archive error", { error: err.message });
            archive.abort();
        });
        res.on("close", () => archive.abort());
        archive.pipe(res);

        await archiveItems(ctx.adapter, archive, paths);
        archive.finalize();
    } catch (err) {
        // Same rationale as GET / — see that handler's catch for why destroy() and not end(). The
        // archive.abort() here is a second call when `archive.on("error", ...)` already ran one; a
        // repeat abort on an aborted archiver is a no-op.
        if (res.headersSent) { archive?.abort(); res.destroy(); return; }
        handleGraphError(res, err);
    }
});

module.exports = app;
module.exports.closeCodeToStatus = closeCodeToStatus;

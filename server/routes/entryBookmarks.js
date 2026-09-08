const { Router } = require("express");
const { authenticate } = require("../middlewares/auth");
const { validateSchema } = require("../utils/schema");
const { sendError } = require("../utils/error");
const logger = require("../utils/logger");
const { bookmarkWriteLimiter } = require("../lib/bookmarkRateLimiter");
const { createBookmarkValidation, orderBookmarksValidation } = require("../validations/bookmarks");
const { listBookmarks, createBookmark, reorderBookmarks, authorizeEntry, toBookmarkResponse } = require("../controllers/bookmarks");

const app = Router();

/**
 * GET /entries/{entryId}/bookmarks
 * @summary List Bookmarks
 * @description Lists the directories the authenticated account has pinned on this server entry, ordered by position. The GET is unlimited - the bar reloads it on every cross-tile bookmark change.
 * @tags Bookmarks
 * @produces application/json
 * @security BearerAuth
 * @param {number} entryId.path.required - Entry ID
 * @return {array<object>} 200 - The account's bookmarks for this entry
 * @return {object} 403 - No permission to browse files on this server
 * @return {object} 404 - Server not found
 */
app.get("/:entryId/bookmarks", authenticate, async (req, res) => {
    const entry = await authorizeEntry(req.user.id, req.params.entryId);
    if (!entry.valid) return sendError(res, entry.code, entry.code, entry.message);

    const bookmarks = await listBookmarks(req.user.id, entry.entry.id);
    res.json(bookmarks.map(toBookmarkResponse));
});

/**
 * POST /entries/{entryId}/bookmarks
 * @summary Create Bookmark
 * @description Pins a directory on a server entry for the authenticated account. The path is normalized before it is stored; pinning an already pinned directory answers 409.
 * @tags Bookmarks
 * @produces application/json
 * @security BearerAuth
 * @param {number} entryId.path.required - Entry ID
 * @param {object} request.body.required - { name, path }
 * @return {object} 201 - The created bookmark
 * @return {object} 400 - Invalid request body
 * @return {object} 403 - No permission to browse files on this server
 * @return {object} 404 - Server not found
 * @return {object} 409 - This directory is already bookmarked
 */
app.post("/:entryId/bookmarks", authenticate, bookmarkWriteLimiter, async (req, res) => {
    if (validateSchema(res, createBookmarkValidation, req.body)) return;

    const entry = await authorizeEntry(req.user.id, req.params.entryId);
    if (!entry.valid) return sendError(res, entry.code, entry.code, entry.message);

    try {
        const bookmark = await createBookmark(req.user.id, entry.entry.id, req.body);
        res.status(201).json(toBookmarkResponse(bookmark));
    } catch (error) {
        // The unique index is the single source of truth for "this folder is already bookmarked",
        // so hitting it is an ordinary outcome, not a fault. Nothing from the driver goes into the
        // response: error.parent.message names the table and all three index columns.
        if (error.name === "SequelizeUniqueConstraintError")
            return sendError(res, 409, 409, "This folder is already bookmarked.");
        throw error;
    }
});

/**
 * PUT /entries/{entryId}/bookmarks/order
 * @summary Reorder Bookmarks
 * @description Rewrites the position of every bookmark the account has on this entry, gapless from 0. The submitted id set must exactly match the account's current bookmarks for this entry, or the request is refused as stale.
 * @tags Bookmarks
 * @produces application/json
 * @security BearerAuth
 * @param {number} entryId.path.required - Entry ID
 * @param {object} request.body.required - { ids }
 * @return {object} 200 - Bookmarks reordered
 * @return {object} 400 - Invalid request body
 * @return {object} 403 - No permission to browse files on this server
 * @return {object} 404 - Server not found
 * @return {object} 409 - The id set is stale, or a conflicting write is in progress
 */
app.put("/:entryId/bookmarks/order", authenticate, bookmarkWriteLimiter, async (req, res) => {
    if (validateSchema(res, orderBookmarksValidation, req.body)) return;

    const entry = await authorizeEntry(req.user.id, req.params.entryId);
    if (!entry.valid) return sendError(res, entry.code, entry.code, entry.message);

    const ok = await reorderBookmarks(req.user.id, entry.entry.id, req.body.ids);
    if (!ok) return sendError(res, 409, 409, "The bookmark order is out of date. Please reload.");

    res.json({ success: true });
});

// Express 5 hands a rejected async handler to the error middleware, and server/index.js installs
// none - the built-in fallback answers with err.stack whenever NODE_ENV is not "production".
app.use((error, req, res, _next) => {
    logger.error("Bookmark route failed", { path: req.originalUrl, error: error.message });
    sendError(res, 500, 500, "Could not complete the bookmark request.");
});

module.exports = app;

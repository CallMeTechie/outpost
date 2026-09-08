const { Router } = require("express");
const { authenticate } = require("../middlewares/auth");
const { validateSchema } = require("../utils/schema");
const { sendError } = require("../utils/error");
const logger = require("../utils/logger");
const { bookmarkWriteLimiter } = require("../lib/bookmarkRateLimiter");
const { renameBookmarkValidation } = require("../validations/bookmarks");
const { renameBookmark, deleteBookmark, authorizeBookmark } = require("../controllers/bookmarks");

const app = Router();

/**
 * PATCH /bookmarks/{id}
 * @summary Rename Bookmark
 * @description Renames one of the authenticated account's own bookmarks. The pinned path itself never changes here.
 * @tags Bookmarks
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Bookmark ID
 * @param {object} request.body.required - { name }
 * @return {object} 200 - Bookmark renamed
 * @return {object} 400 - Invalid request body
 * @return {object} 403 - No permission to browse files on this server anymore
 * @return {object} 404 - Bookmark not found
 */
app.patch("/:id", authenticate, bookmarkWriteLimiter, async (req, res) => {
    if (validateSchema(res, renameBookmarkValidation, req.body)) return;

    const check = await authorizeBookmark(req.user.id, req.params.id);
    if (!check.valid) return sendError(res, check.code, check.code, check.message);

    await renameBookmark(req.user.id, check.bookmark.id, req.body.name);
    res.json({ success: true });
});

/**
 * DELETE /bookmarks/{id}
 * @summary Delete Bookmark
 * @description Unpins one of the authenticated account's own bookmarks and closes the position gap left behind.
 * @tags Bookmarks
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - Bookmark ID
 * @return {object} 200 - Bookmark deleted
 * @return {object} 403 - No permission to browse files on this server anymore
 * @return {object} 404 - Bookmark not found
 */
app.delete("/:id", authenticate, bookmarkWriteLimiter, async (req, res) => {
    const check = await authorizeBookmark(req.user.id, req.params.id);
    if (!check.valid) return sendError(res, check.code, check.code, check.message);

    const deleted = await deleteBookmark(req.user.id, check.bookmark.id);
    if (!deleted) return sendError(res, 404, 404, "Bookmark not found.");

    res.json({ success: true });
});

// Express 5 hands a rejected async handler to the error middleware, and server/index.js installs
// none - the built-in fallback answers with err.stack whenever NODE_ENV is not "production".
app.use((error, req, res, _next) => {
    logger.error("Bookmark route failed", { path: req.originalUrl, error: error.message });
    sendError(res, 500, 500, "Could not complete the bookmark request.");
});

module.exports = app;

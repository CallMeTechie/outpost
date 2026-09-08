const Joi = require("joi");

// Control characters have no place in a remote path or a display name: a NUL truncates the path on
// its way to the C engine, and a newline in a name breaks every log line it lands in. Written as
// escapes on purpose - a literal control character in this file is invisible in every diff.
const NO_CONTROL_CHARS = /^[^\u0000-\u001F\u007F]+$/;

// 1024 *bytes*, not characters: the column is STRING(1024) and paneStateStore.js measures the same
// way. Without the encoding argument Joi counts characters, and a 600-character CJK path would pass
// here and break on the insert - under MySQL only, which is exactly the dialect split this design
// goes out of its way to avoid.
module.exports.createBookmarkValidation = Joi.object({
    name: Joi.string().min(1).max(255).pattern(NO_CONTROL_CHARS).required(),
    // 1023, not 1024: normalizeBookmarkPath prepends a "/" to a relative path, and the column is
    // STRING(1024). What is measured here is the input; what gets written is one byte longer.
    path: Joi.string().min(1).max(1023, "utf8").pattern(NO_CONTROL_CHARS).required(),
}).unknown(false);

module.exports.renameBookmarkValidation = Joi.object({
    name: Joi.string().min(1).max(255).pattern(NO_CONTROL_CHARS).required(),
}).unknown(false);

// Bounded and duplicate-free: the route compares against the account's own bookmarks, so a list
// longer than any plausible bar is a request nobody legitimately makes.
module.exports.orderBookmarksValidation = Joi.object({
    ids: Joi.array().items(Joi.number().integer().positive()).max(500).unique().required(),
}).unknown(false);

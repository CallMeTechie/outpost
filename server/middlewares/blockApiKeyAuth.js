const { sendError } = require("../utils/error");

const blockApiKeyAuth = (req, res, next) => {
    if (req.apiKey) return sendError(res, 403, 403, "API keys cannot manage API keys");
    next();
};

module.exports = { blockApiKeyAuth };

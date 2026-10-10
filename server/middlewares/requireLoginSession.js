const { sendError } = require("../utils/error");

const requireLoginSession = (req, res, next) => {
    if (req.apiKey || !req.session || req.session.impersonatorId)
        return sendError(res, 403, 403, "This action requires a signed-in session");
    next();
};

module.exports = { requireLoginSession };

const { authenticateBrowserSession } = require("../middlewares/wsAuth");
const logger = require("../utils/logger");

const KEEPALIVE_MS = 30000;

// An unhandled rejection here ends the process (errorHandling.js).
module.exports = async (ws, req) => {
    try {
        const context = await authenticateBrowserSession(ws, req.query);
        if (!context) return;
        // The socket can close while token and permission are checked; its "close" has fired by then.
        if (ws.readyState !== ws.OPEN) return;

        const { browserSession, user } = context;
        let alive = true;
        // A static page sends no frames; without pings a proxy idle timeout or a sleeping laptop
        // leaves a dead viewer in the list, which blocks idle end and the size of the next viewer.
        const keepAlive = setInterval(() => {
            if (ws.readyState !== ws.OPEN) return;
            if (!alive) return ws.terminate();
            alive = false;
            try {
                ws.ping();
            } catch {}
        }, KEEPALIVE_MS);
        const leave = () => {
            clearInterval(keepAlive);
            browserSession.removeViewer(ws);
        };

        ws.on("pong", () => {
            alive = true;
        });
        ws.on("message", (data, isBinary) => {
            if (isBinary) return;
            let message;
            try {
                message = JSON.parse(data.toString());
            } catch {
                return;
            }
            browserSession.handleViewerMessage(ws, message).catch((err) => {
                logger.warn("Browser viewer message failed", { user: user.username, session: browserSession.id, error: err.message });
            });
        });
        ws.on("close", leave);
        ws.on("error", leave);
        // Last: messages that arrive before a listener exists are dropped by ws.
        browserSession.addViewer(ws);
    } catch (err) {
        logger.error("Browser socket failed", { error: err.message });
        try {
            ws.close(1011, "Internal error");
        } catch {}
    }
};

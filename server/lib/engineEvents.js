const SessionManager = require("./SessionManager");
const logger = require("../utils/logger");

const remove = (engineSessionId, options) => {
    const target = SessionManager.resolveEngineSession(engineSessionId);
    if (!target) return;
    SessionManager.remove(target.sessionId, { ...options, generation: target.generation })
        .catch((error) => logger.error("Removing session failed", { sessionId: target.sessionId, error: error.message }));
};

module.exports.handleSessionClosed = ({ sessionId: engineSessionId, reason }) => {
    logger.info(`Engine session closed: ${engineSessionId} (reason: ${reason})`);
    remove(engineSessionId, reason === "connection lost" ? { code: 4017, reason: "Connection lost" } : {});
};

module.exports.handleEngineDisconnected = ({ engineId, sessionIds }) => {
    logger.warn(`Engine ${engineId} disconnected, cleaning up ${sessionIds.length} sessions`);
    for (const engineSessionId of sessionIds) remove(engineSessionId, { code: 4017, reason: "Engine disconnected" });
};

const SessionManager = require("./SessionManager");
const logger = require("../utils/logger");

const currentTarget = (engineSessionId, event) => {
    const target = SessionManager.resolveEngineSession(engineSessionId);
    if (!target) return null;
    const session = SessionManager.get(target.sessionId);
    if (!session) return null;
    if (session.generation !== target.generation) {
        logger.info(`Ignoring ${event} for an older generation`, { engineSessionId, current: session.generation });
        return null;
    }
    return target;
};

const remove = (target, options) => SessionManager.remove(target.sessionId, { ...options, generation: target.generation })
    .catch((error) => logger.error("Removing session failed", { sessionId: target.sessionId, error: error.message }));

module.exports.handleSessionClosed = ({ sessionId: engineSessionId, reason }) => {
    logger.info(`Engine session closed: ${engineSessionId} (reason: ${reason})`);
    const target = currentTarget(engineSessionId, "sessionClosed");
    if (!target) return;
    const ending = reason === "connection lost" ? { code: 4017, reason: "Connection lost" } : {};
    remove(target, ending);
};

module.exports.handleEngineDisconnected = ({ engineId, sessionIds }) => {
    logger.warn(`Engine ${engineId} disconnected, cleaning up ${sessionIds.length} sessions`);
    for (const engineSessionId of sessionIds) {
        const target = currentTarget(engineSessionId, "engineDisconnected");
        if (target) remove(target, { code: 4017, reason: "Engine disconnected" });
    }
};

const Account = require("../models/Account");
const Session = require("../models/Session");
const Entry = require("../models/Entry");
const { isApiKeyToken, validateApiKey, touchApiKey } = require("../controllers/apiKey");
const { checkAgentIp } = require("../lib/vault/ipBinding");
const auditContext = require("../utils/auditContext");

const PROBE_PATH = "/api/vault/agent-keys/probe";
const INVALID_API_KEY = { message: "The provided API key is not valid" };

const pathOf = (req) => req.originalUrl.split("?")[0];
const isMcpPath = (path) => path === "/api/mcp" || path.startsWith("/api/mcp/");

const rejectAgentKey = async (req, apiKey) => {
    const { isVaultEnabled } = require("../lib/vault/state");
    if (!isVaultEnabled()) return { status: 401, body: INVALID_API_KEY };

    const path = pathOf(req);
    if (apiKey.pending)
        return req.method === "GET" && path === PROBE_PATH ? null : { status: 401, body: INVALID_API_KEY };

    if (!isMcpPath(path))
        return { status: 403, body: { code: 403, message: "Agent keys can only access the MCP endpoint" } };

    const { validateEntryAccess } = require("../controllers/entry");
    const entry = await Entry.findByPk(apiKey.entryId);
    if (!(await validateEntryAccess(apiKey.accountId, entry)).valid)
        return { status: 403, body: { code: 403, message: "The server of this agent key is no longer accessible" } };

    if (!(await checkAgentIp(apiKey, entry, req.ip)))
        return { status: 403, body: { code: 403, message: "This agent key is not allowed from this address" } };

    return null;
};

module.exports.authenticate = async (req, res, next) => {
    const authHeader = req.header("authorization");
    if (!authHeader)
        return res.status(400).json({ message: "You need to provide the 'authorization' header" });

    const headerTrimmed = authHeader.split(" ");
    if (headerTrimmed.length !== 2)
        return res.status(400).json({ message: "You need to provide the token in the 'authorization' header" });

    const token = headerTrimmed[1];

    if (isApiKeyToken(token)) {
        const result = await validateApiKey(token);
        if (!result)
            return res.status(401).json(INVALID_API_KEY);

        if (result.apiKey.kind === "agent") {
            const rejection = await rejectAgentKey(req, result.apiKey);
            if (rejection) return res.status(rejection.status).json(rejection.body);
            await touchApiKey(result.apiKey.id);
            req.agent = { keyId: result.apiKey.id, entryId: result.apiKey.entryId, agentType: result.apiKey.agentType };
        }

        req.apiKey = result.apiKey;
        req.user = result.account;
        return next();
    }

    req.session = await Session.findOne({ where: { token } });

    if (req.session === null)
        return res.status(401).json({ message: "The provided token is not valid" });

    await Session.update({ lastActivity: new Date(), ip: req.ip }, { where: { id: req.session.id } });

    req.user = await Account.findByPk(req.session.accountId);
    if (req.user === null)
        return res.status(401).json({ message: "The account associated to the token is not registered" });

    // Timers and emitters created inside the request inherit this store: code that creates a long-lived
    // timer lazily on first use must not rely on it for audit attribution.
    if (req.session.impersonatorId)
        return auditContext.run({ impersonatorId: req.session.impersonatorId }, next);

    next();
};

module.exports.authenticateQuery = async (req, res, next) => {
    const token = req.query.token;
    if (!token) return res.status(401).json({ message: "Token required" });

    const session = await Session.findOne({ where: { token } });
    if (!session) return res.status(401).json({ message: "Invalid token" });

    const user = await Account.findByPk(session.accountId);
    if (!user) return res.status(401).json({ message: "Invalid token" });

    req.user = user;
    req.session = session;
    next();
};

module.exports.authenticateDownload = async (req, res, next) => {
    const token = req.query.token;
    if (!token) return res.status(401).json({ message: "Token required" });
    
    const session = await Session.findOne({ where: { token } });
    if (!session) return res.status(401).json({ message: "Invalid token" });
    
    const user = await Account.findByPk(session.accountId);
    if (!user) return res.status(401).json({ message: "Invalid token" });

    const { hasSystemPermission } = require("../permissions/engine");
    const { Permission } = require("../permissions/registry");
    if (!(await hasSystemPermission(user.id, Permission.SETTINGS_BACKUP)))
        return res.status(403).json({ message: "Insufficient permissions" });

    req.user = user;
    req.session = session;
    next();
};


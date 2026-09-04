const Session = require("../models/Session");
const Account = require("../models/Account");
const Entry = require("../models/Entry");
const { buildTransientEntry } = require("../utils/directTarget");
const Integration = require("../models/Integration");
const SessionManager = require("../lib/SessionManager");
const { validateEntryAccess } = require("../controllers/entry");
const { getOrganizationAuditSettingsInternal } = require("../controllers/audit");
const { resolveIdentity } = require("../utils/identityResolver");

const SHARED_ENTRY_ATTRIBUTES = ["id", "type", "config", "integrationId"];

// The part of "authenticate this token" that has nothing to do with a socket: a lookup and a
// pass/fail answer. Split out so an HTTP route (oneDriveContent.js) can ask the identical question
// authenticateToken asks a WebSocket, instead of a second copy of this lookup growing beside it and
// drifting the day one of the two gains a check the other doesn't. The close code travels with the
// failure so authenticateToken below can still close exactly as it did before this was split out;
// an HTTP caller has no equivalent and is expected to ignore it.
const resolveSessionToken = async (sessionToken) => {
    if (!sessionToken) {
        return { ok: false, code: 4001, reason: "You need to provide the token in the 'sessionToken' parameter" };
    }

    const session = await Session.findOne({ where: { token: sessionToken } });
    if (!session) return { ok: false, code: 4003, reason: "The token is not valid" };

    await Session.update({ lastActivity: new Date() }, { where: { id: session.id } });

    const user = await Account.findByPk(session.accountId);
    if (!user) return { ok: false, code: 4004, reason: "The token is not valid" };

    return { ok: true, session, user };
};

const authenticateToken = async (ws, sessionToken) => {
    const result = await resolveSessionToken(sessionToken);
    if (!result.ok) return ws.close(result.code, result.reason), null;

    return { session: result.session, user: result.user };
};

const buildSharedContext = (query, serverSession, entry, overrides) => ({
    entry,
    integration: null,
    identity: null,
    user: null,
    session: null,
    serverSession,
    containerId: "0",
    connectionReason: null,
    ipAddress: query.ip || "unknown",
    userAgent: query.userAgent || "unknown",
    isShared: true,
    ...overrides,
});

const authenticateSharedSession = async (ws, query) => {
    const { shareId } = query;
    if (!shareId) return null;

    const session = SessionManager.getByShareId(shareId);
    if (!session) return ws.close(4013, "Invalid share link"), null;

    const entry = await Entry.findByPk(session.entryId, { attributes: SHARED_ENTRY_ATTRIBUTES });
    if (!entry) return ws.close(4005, "Entry not found"), null;

    return buildSharedContext(query, session, entry, { shareWritable: session.shareWritable });
};

const authenticateOrganizationJoin = async (ws, query) => {
    const { joinSessionId } = query;
    if (!joinSessionId) return null;

    const auth = await authenticateToken(ws, query.sessionToken);
    if (!auth) return null;

    const access = await require("../controllers/liveSession").resolveJoinAccess(auth.user.id, joinSessionId);
    if (access.code) return ws.close(access.code === 404 ? 4007 : 4003, access.message), null;

    const entry = await Entry.findByPk(access.session.entryId, { attributes: SHARED_ENTRY_ATTRIBUTES });
    if (!entry) return ws.close(4005, "Entry not found"), null;

    SessionManager.updateActivity(joinSessionId);

    return buildSharedContext(query, access.session, entry, {
        user: auth.user,
        session: auth.session,
        isOrgJoin: true,
        shareWritable: access.writable,
    });
};

const authenticateWebSocket = async (ws, query) => {
    const { entryId, sessionId } = query;

    const auth = await authenticateToken(ws, query.sessionToken);
    if (!auth) return null;

    const { session, user } = auth;

    let targetEntryId = entryId;
    let serverSession = null;

    if (sessionId) {
        serverSession = SessionManager.get(sessionId);
        if (!serverSession) {
            const failedReason = SessionManager.consumeFailedReason(sessionId);
            if (failedReason) ws.close(4017, failedReason);
            else ws.close(4007, "Invalid session ID");
            return null;
        }
        if (serverSession.accountId !== user.id) {
            ws.close(4003, "Unauthorized session access");
            return null;
        }
        targetEntryId = serverSession.entryId;
        SessionManager.updateActivity(sessionId);
    }

    // A one-off connection has no entry, and none of the checks below can be
    // run against one. What stands in their place is already settled: the
    // session belongs to this account (checked above), and it could only have
    // been created with the connect.direct permission in the first place. The
    // target is rebuilt into the same shape the rest of this path expects.
    const directTarget = serverSession?.configuration?.directTarget;
    if (directTarget) {
        return { user, entry: buildTransientEntry(directTarget), session, serverSession };
    }

    if (!targetEntryId) {
        ws.close(4002, "You need to provide the entryId or sessionId");
        return null;
    }

    const entry = await Entry.findByPk(targetEntryId);
    if (!entry) {
        ws.close(4005, "Entry not found");
        return null;
    }

    const accessResult = await validateEntryAccess(user.id, entry);
    if (!accessResult.valid) {
        ws.close(4005, "You don't have access to this entry");
        return null;
    }

    return { user, entry, session, serverSession };
}

module.exports = async (ws, req) => {
    const sharedAuth = await authenticateSharedSession(ws, req.query);
    if (sharedAuth) return sharedAuth;

    const orgJoinAuth = await authenticateOrganizationJoin(ws, req.query);
    if (orgJoinAuth) return orgJoinAuth;

    const baseAuth = await authenticateWebSocket(ws, req.query);
    if (!baseAuth) return null;

    const { user, entry, session, serverSession } = baseAuth;
    let { identityId, connectionReason, containerId } = req.query;
    let directIdentity = null;

    if (serverSession) {
        if (serverSession.configuration?.identityId) identityId = serverSession.configuration.identityId;
        if (serverSession.configuration?.directIdentity) directIdentity = serverSession.configuration.directIdentity;
        if (serverSession.connectionReason) connectionReason = serverSession.connectionReason;
    }

    const integration = entry.integrationId ? await Integration.findByPk(entry.integrationId) : null;

    if (entry.organizationId) {
        const auditSettings = await getOrganizationAuditSettingsInternal(entry.organizationId);
        if (auditSettings?.requireConnectionReason && !connectionReason) {
            ws.close(4008, "Connection reason required");
            return null;
        }
    }

    const result = await resolveIdentity(entry, identityId, directIdentity, user.id);
    const identity = result?.identity !== undefined ? result.identity : result;

    if (result.accessDenied) {
        ws.close(4006, "You don't have access to this identity");
        return null;
    }

    if (result.requiresIdentity && !identity) {
        ws.close(4006, "Identity not found");
        return null;
    }

    return {
        entry,
        integration,
        identity,
        user,
        session,
        serverSession,
        containerId: containerId || "0",
        connectionReason: connectionReason || null,
        ipAddress: req.ip || req.socket?.remoteAddress || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
    };
};

module.exports.authenticateWebSocket = authenticateWebSocket;
module.exports.authenticateToken = authenticateToken;
module.exports.resolveSessionToken = resolveSessionToken;
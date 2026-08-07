const Entry = require("../models/Entry");
const { resolveIdentity } = require("../utils/identityResolver");
const { getIdentityCredentials } = require("./identity");
const { buildSSHParams, resolveJumpHosts } = require("../lib/ConnectionService");
const { validateEntryAccess } = require("./entry");
const controlPlane = require("../lib/controlPlane/ControlPlaneServer");
const TmuxService = require("../lib/tmux/TmuxService");
const { Permission } = require("../permissions/registry");
const { isAllowedSession, isValidCreateName } = require("../lib/tmux/commands");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("./audit");
const logger = require("../utils/logger");

/** Resolves everything TmuxService needs to reach the host, or an error object. */
const resolveTarget = async (accountId, entryId, identityId) => {
    const entry = await Entry.findByPk(entryId);
    if (!entry) return { code: 404, message: "Entry not found" };

    // 404, not 403: a caller without access must not be able to tell "exists
    // but not yours" apart from "does not exist".
    const accessResult = await validateEntryAccess(accountId, entry, "Access denied", Permission.CONNECT_SSH);
    if (!accessResult.valid) return { code: 404, message: "Entry not found" };

    if (entry.config?.protocol !== "ssh") {
        return { code: 400, message: "tmux is only supported for SSH entries" };
    }

    if (!controlPlane.hasEngine()) return { code: 502, message: "No engine connected" };

    const result = await resolveIdentity(entry, identityId, null, accountId);
    const identity = result?.identity !== undefined ? result.identity : result;

    if (result.accessDenied) return { code: 400, message: "You don't have access to this identity" };
    if (!identity || !identity.id) return { code: 400, message: "No identity available for this entry" };

    const host = entry.config?.ip;
    if (!host) return { code: 400, message: "Missing host configuration" };

    const credentials = await getIdentityCredentials(identity.id);
    return {
        organizationId: entry.organizationId,
        target: {
            host,
            port: entry.config?.port || 22,
            params: buildSSHParams(identity, credentials),
            jumpHosts: await resolveJumpHosts(entry),
            engineId: entry.config?.engineId ?? null,
        },
    };
};

const getTmuxSessions = async (accountId, entryId, identityId) => {
    const resolved = await resolveTarget(accountId, entryId, identityId);
    if (resolved.code) return resolved;

    try {
        return await TmuxService.listSessions(resolved.target);
    } catch (error) {
        if (error.code === "TMUX_TIMEOUT") return { code: 502, message: error.message };
        return { code: 502, message: error.message || "tmux query failed" };
    }
};

/** The allowlist: the name must appear in a listing the server just fetched. */
const requireListedSession = async (target, name) => {
    const listing = await TmuxService.listSessions(target);
    if (!listing.available) return { code: 400, message: "tmux is not available on this host" };
    if (!isAllowedSession(name, listing.sessions)) return { code: 400, message: "Unknown tmux session" };
    return { listing };
};

/**
 * Only errors the tmux layer raised on purpose reach the client. Anything else
 * — a TypeError in this module, an internal control-plane message — is logged
 * and answered with a fixed sentence. CONNECT_SSH defaults to true, so every
 * organisation member can reach these endpoints.
 */
const tmuxFailure = (error, fallback) => {
    if (error.code === "TMUX_TIMEOUT" || error.code === "TMUX_FAILED") {
        return { code: 502, message: error.message };
    }
    logger.error("tmux action failed", { code: error.code, error: error.message });
    return { code: 502, message: fallback };
};

/**
 * The action already succeeded when this runs, so a failing refresh must not
 * turn into an error — the user would act a second time on a done action.
 */
const listAfterAction = async (target) => {
    try {
        const listing = await TmuxService.listSessions(target);
        // listSessions returns rather than throws when it thinks tmux is
        // missing. Right after a successful action that reading is untrustworthy
        // — answering with its empty list would make the client display "no
        // sessions" as the new truth.
        if (!listing.available) return { available: true, refreshed: false };
        return listing;
    } catch {
        return { available: true, refreshed: false };
    }
};

const killTmuxSession = async (accountId, entryId, identityId, name, ipAddress = null, userAgent = null) => {
    const resolved = await resolveTarget(accountId, entryId, identityId);
    if (resolved.code) return resolved;

    try {
        const allowed = await requireListedSession(resolved.target, name);
        if (allowed.code) return allowed;

        await TmuxService.killSession(resolved.target, name);

        await createAuditLog({
            accountId, organizationId: resolved.organizationId, action: AUDIT_ACTIONS.TMUX_KILL,
            resource: RESOURCE_TYPES.ENTRY, resourceId: String(entryId),
            details: { session: name }, ipAddress, userAgent,
        });
    } catch (error) {
        // The session vanished between the listing and the kill. That is not a
        // transport failure, so it must not be a 502.
        if (error.code === "TMUX_FAILED" && /can'?t find session/i.test(error.message || "")) {
            return { code: 400, message: "Unknown tmux session" };
        }
        return tmuxFailure(error, "tmux kill failed");
    }

    return await listAfterAction(resolved.target);
};

const renameTmuxSession = async (accountId, entryId, identityId, name, newName, ipAddress = null, userAgent = null) => {
    if (!isValidCreateName(newName)) {
        return { code: 400, message: "Session names may contain letters, digits, underscore and dash, up to 64 characters" };
    }

    const resolved = await resolveTarget(accountId, entryId, identityId);
    if (resolved.code) return resolved;

    try {
        const allowed = await requireListedSession(resolved.target, name);
        if (allowed.code) return allowed;

        await TmuxService.renameSession(resolved.target, name, newName);

        await createAuditLog({
            accountId, organizationId: resolved.organizationId, action: AUDIT_ACTIONS.TMUX_RENAME,
            resource: RESOURCE_TYPES.ENTRY, resourceId: String(entryId),
            details: { session: name, newName }, ipAddress, userAgent,
        });
    } catch (error) {
        if (error.code === "TMUX_DUPLICATE") return { code: 409, message: `A session named "${newName}" already exists` };
        if (error.code === "TMUX_FAILED" && /can'?t find session/i.test(error.message || "")) {
            return { code: 400, message: "Unknown tmux session" };
        }
        return tmuxFailure(error, "tmux rename failed");
    }

    return await listAfterAction(resolved.target);
};

module.exports = { getTmuxSessions, killTmuxSession, renameTmuxSession };

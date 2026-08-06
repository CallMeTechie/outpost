const Entry = require("../models/Entry");
const { resolveIdentity } = require("../utils/identityResolver");
const { getIdentityCredentials } = require("./identity");
const { buildSSHParams, resolveJumpHosts } = require("../lib/ConnectionService");
const { validateEntryAccess } = require("./entry");
const controlPlane = require("../lib/controlPlane/ControlPlaneServer");
const TmuxService = require("../lib/tmux/TmuxService");

const getTmuxSessions = async (accountId, entryId, identityId) => {
    const entry = await Entry.findByPk(entryId);
    if (!entry) return { code: 404, message: "Entry not found" };

    const accessResult = await validateEntryAccess(accountId, entry);
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
    const target = {
        host,
        port: entry.config?.port || 22,
        params: buildSSHParams(identity, credentials),
        jumpHosts: await resolveJumpHosts(entry),
        engineId: entry.config?.engineId ?? null,
    };

    try {
        return await TmuxService.listSessions(target);
    } catch (error) {
        if (error.code === "TMUX_TIMEOUT") return { code: 502, message: error.message };
        return { code: 502, message: error.message || "tmux query failed" };
    }
};

module.exports = { getTmuxSessions };

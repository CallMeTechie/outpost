const { randomUUID } = require("node:crypto");
const stateBroadcaster = require("../StateBroadcaster");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("../../controllers/audit");
const { VaultError, VaultErrorCode } = require("./errors");
const { itemRef } = require("./visibility");

const APPROVAL_TTL_MS = 120000;
const DENY_LOCK_MS = 60000;
const MAX_OPEN_PER_CALLER = 3;
const GIT_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const GIT_SESSION_PREFIX = "git:";

let open = new Map();
let closed = new Map();
let sessionGrants = new Map();
let sessionSeen = new Map();
let denials = new Map();

const callerKey = (accountId, keyId) => `${accountId}:${keyId ?? "session"}`;
const denialKey = (accountId, keyId, itemId) => `${callerKey(accountId, keyId)}:${itemId}`;
const grantKey = (itemId, scope) => JSON.stringify([itemId, scope ?? null]);
const sorted = (list) => [...(list ?? [])].sort();
const grantStamp = (item) => {
    const fields = item.fields ?? {};
    return JSON.stringify([
        new Date(item.updatedAt).getTime(), sorted(fields.origins), sorted(fields.hosts),
        fields.readOnly === true, fields.allowHttp === true, fields.git === true, fields.gitUsername ?? null, sorted(fields.fillOrigins),
    ]);
};
const early = (code) => new VaultError(code, undefined, { early: true });

const gitSessionId = (keyId) => `${GIT_SESSION_PREFIX}${keyId}`;
const isGitSession = (id) => typeof id === "string" && id.startsWith(GIT_SESSION_PREFIX);
const touchSession = (id) => {
    const now = Date.now();
    if (now - (sessionSeen.get(id) ?? now) >= GIT_SESSION_IDLE_MS) sessionGrants.delete(id);
    sessionSeen.set(id, now);
};

const publish = (accountId) =>
    stateBroadcaster.sendStateToAccount(accountId, stateBroadcaster.STATE_TYPES.VAULT_APPROVALS).catch(() => {});

const audit = (request, action, details = {}, meta = {}) => createAuditLog({
    accountId: request.accountId, organizationId: request.organizationId, action,
    resource: RESOURCE_TYPES.VAULT, resourceId: request.itemId,
    details: {
        item: request.item, agentType: request.agentType, entryName: request.entryName, keyId: request.keyId,
        tool: request.tool, access: request.access, target: request.target, ...details,
    },
    ipAddress: meta.ipAddress ?? null, userAgent: meta.userAgent ?? null,
});

const dropIdleGitSessions = (now) => {
    for (const [id, seen] of sessionSeen) {
        if (now - seen < GIT_SESSION_IDLE_MS) continue;
        sessionSeen.delete(id);
        sessionGrants.delete(id);
    }
};

const prune = (now) => {
    for (const [id, entry] of closed) if (entry.until <= now) closed.delete(id);
    for (const [key, until] of denials) if (until <= now) denials.delete(key);
    dropIdleGitSessions(now);
};

const close = (request, status) => {
    open.delete(request.id);
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.onAbort);
    closed.set(request.id, { accountId: request.accountId, status, until: Date.now() + APPROVAL_TTL_MS });
    publish(request.accountId);
};

const expire = (request, reason) => {
    if (!open.has(request.id)) return;
    close(request, 410);
    audit(request, AUDIT_ACTIONS.VAULT_APPROVAL_TIMEOUT, { reason });
    request.reject(new VaultError(reason === "expired" ? VaultErrorCode.APPROVAL_TIMEOUT : VaultErrorCode.CLIENT_GONE));
};

const hasSessionApproval = (transportId, item, scope) => {
    if (isGitSession(transportId)) dropIdleGitSessions(Date.now());
    return sessionGrants.get(transportId)?.get(grantKey(item.id, scope)) === grantStamp(item);
};

const requestApproval = async ({
    accountId, keyId = null, transportId, agentType = null, entryName = null, impersonated = false,
    item, target, tool, access, scope = access, signal,
}) => {
    if (hasSessionApproval(transportId, item, scope)) return "session";
    const now = Date.now();
    prune(now);
    if ((denials.get(denialKey(accountId, keyId, item.id)) ?? 0) > now) throw early(VaultErrorCode.APPROVAL_DENIED);
    const waiting = [...open.values()];
    if (waiting.some((request) => request.transportId === transportId && request.itemId === item.id))
        throw early(VaultErrorCode.APPROVAL_PENDING);
    if (waiting.filter((request) => request.caller === callerKey(accountId, keyId)).length >= MAX_OPEN_PER_CALLER)
        throw early(VaultErrorCode.APPROVAL_BUSY);
    if (!stateBroadcaster.hasConnection(accountId)) throw early(VaultErrorCode.APPROVAL_UNAVAILABLE);
    if (signal?.aborted) throw early(VaultErrorCode.CLIENT_GONE);

    return new Promise((resolve, reject) => {
        const request = {
            id: randomUUID(), accountId, keyId, caller: callerKey(accountId, keyId), transportId,
            itemId: item.id, stamp: grantStamp(item), organizationId: item.organizationId ?? null, item: itemRef(item),
            agentType, entryName, impersonated: Boolean(impersonated), target, tool, access, scope,
            expiresAt: now + APPROVAL_TTL_MS, resolve, reject, signal,
        };
        request.timer = setTimeout(() => expire(request, "expired"), APPROVAL_TTL_MS);
        request.onAbort = () => expire(request, "client_gone");
        signal?.addEventListener("abort", request.onAbort, { once: true });
        open.set(request.id, request);
        publish(accountId);
    });
};

const answerApproval = (id, accountId, decision, meta = {}) => {
    const now = Date.now();
    prune(now);
    const request = open.get(id);
    if (!request) {
        const done = closed.get(id);
        return { status: done && Number(done.accountId) === Number(accountId) ? done.status : 404 };
    }
    if (Number(request.accountId) !== Number(accountId)) return { status: 404 };
    if (now >= request.expiresAt) {
        expire(request, "expired");
        return { status: 410 };
    }
    if (decision === "session" && request.impersonated) return { status: 400, code: VaultErrorCode.SESSION_NOT_ALLOWED };
    close(request, 409);
    if (decision === "deny") {
        denials.set(denialKey(request.accountId, request.keyId, request.itemId), now + DENY_LOCK_MS);
        audit(request, AUDIT_ACTIONS.VAULT_DENY, {}, meta);
        request.reject(new VaultError(VaultErrorCode.APPROVAL_DENIED));
    } else {
        if (decision === "session") {
            if (isGitSession(request.transportId)) touchSession(request.transportId);
            if (!sessionGrants.has(request.transportId)) sessionGrants.set(request.transportId, new Map());
            sessionGrants.get(request.transportId).set(grantKey(request.itemId, request.scope), request.stamp);
        }
        audit(request, AUDIT_ACTIONS.VAULT_APPROVE, { decision }, meta);
        request.resolve(decision);
    }
    return { status: 200 };
};

const listOpenApprovals = (accountId) => {
    const now = Date.now();
    return [...open.values()]
        .filter((request) => Number(request.accountId) === Number(accountId))
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .map(({ id, agentType, entryName, impersonated, item, tool, access, target, expiresAt }) => ({
            id, agentType, entryName, impersonated, item, tool, access, target,
            expiresAt: new Date(expiresAt).toISOString(), remainingMs: Math.max(0, expiresAt - now),
        }));
};

const forgetSession = (id) => {
    sessionGrants.delete(id);
    sessionSeen.delete(id);
    for (const request of [...open.values()]) if (request.transportId === id) expire(request, "client_gone");
};

const _resetForTests = () => {
    for (const request of open.values()) clearTimeout(request.timer);
    open = new Map();
    closed = new Map();
    sessionGrants = new Map();
    sessionSeen = new Map();
    denials = new Map();
};

module.exports = {
    APPROVAL_TTL_MS, GIT_SESSION_IDLE_MS, requestApproval, answerApproval, listOpenApprovals, hasSessionApproval, grantStamp,
    gitSessionId, touchSession, forgetSession, forgetTransport: forgetSession, _resetForTests,
};

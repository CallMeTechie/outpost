const { randomUUID } = require("node:crypto");
const stateBroadcaster = require("../StateBroadcaster");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("../../controllers/audit");
const { VaultError, VaultErrorCode } = require("./errors");
const { itemRef } = require("./visibility");

const APPROVAL_TTL_MS = 120000;
const DENY_LOCK_MS = 60000;
const MAX_OPEN_PER_CALLER = 3;

let open = new Map();
let closed = new Map();
let sessionGrants = new Map();
let denials = new Map();

const callerKey = (accountId, keyId) => `${accountId}:${keyId ?? "session"}`;
const denialKey = (accountId, keyId, itemId) => `${callerKey(accountId, keyId)}:${itemId}`;
const grantStamp = (item) => `${new Date(item.updatedAt).getTime()}|${JSON.stringify([...(item.fields?.origins ?? [])].sort())}`;
const early = (code) => new VaultError(code, undefined, { early: true });

const publish = (accountId) =>
    stateBroadcaster.sendStateToAccount(accountId, stateBroadcaster.STATE_TYPES.VAULT_APPROVALS).catch(() => {});

const audit = (request, action, details = {}, meta = {}) => createAuditLog({
    accountId: request.accountId, organizationId: request.organizationId, action,
    resource: RESOURCE_TYPES.VAULT, resourceId: request.itemId,
    details: { item: request.item, agentType: request.agentType, entryName: request.entryName, keyId: request.keyId, target: request.target, ...details },
    ipAddress: meta.ipAddress ?? null, userAgent: meta.userAgent ?? null,
});

const prune = (now) => {
    for (const [id, entry] of closed) if (entry.until <= now) closed.delete(id);
    for (const [key, until] of denials) if (until <= now) denials.delete(key);
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

const hasSessionApproval = (transportId, item) => sessionGrants.get(transportId)?.get(item.id) === grantStamp(item);

const requestApproval = async ({ accountId, keyId = null, transportId, agentType = null, entryName = null, impersonated = false, item, target, signal }) => {
    if (hasSessionApproval(transportId, item)) return "session";
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
            agentType, entryName, impersonated: Boolean(impersonated), target, expiresAt: now + APPROVAL_TTL_MS, resolve, reject, signal,
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
            if (!sessionGrants.has(request.transportId)) sessionGrants.set(request.transportId, new Map());
            sessionGrants.get(request.transportId).set(request.itemId, request.stamp);
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
        .map(({ id, agentType, entryName, impersonated, item, target, expiresAt }) => ({
            id, agentType, entryName, impersonated, item, target,
            expiresAt: new Date(expiresAt).toISOString(), remainingMs: Math.max(0, expiresAt - now),
        }));
};

const forgetTransport = (transportId) => {
    sessionGrants.delete(transportId);
    for (const request of [...open.values()]) if (request.transportId === transportId) expire(request, "client_gone");
};

const _resetForTests = () => {
    for (const request of open.values()) clearTimeout(request.timer);
    open = new Map();
    closed = new Map();
    sessionGrants = new Map();
    denials = new Map();
};

module.exports = {
    APPROVAL_TTL_MS, requestApproval, answerApproval, listOpenApprovals, hasSessionApproval, forgetTransport, _resetForTests,
};

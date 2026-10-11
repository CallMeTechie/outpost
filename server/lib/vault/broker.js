const { VaultError, VaultErrorCode } = require("./errors");
const { itemRef, findVisibleItem } = require("./visibility");
const { readSecret } = require("./secrets");
const { grantStamp } = require("./approvals");
const VaultItem = require("../../models/VaultItem");
const ApiKey = require("../../models/ApiKey");
const Entry = require("../../models/Entry");
const logger = require("../../utils/logger");

const RATE_AUDIT_WINDOW_MS = 60 * 1000;
const APPROVAL_CODES = new Set([
    VaultErrorCode.APPROVAL_TIMEOUT, VaultErrorCode.APPROVAL_UNAVAILABLE, VaultErrorCode.APPROVAL_PENDING,
    VaultErrorCode.APPROVAL_BUSY, VaultErrorCode.APPROVAL_DENIED, VaultErrorCode.CLIENT_GONE,
]);
const DENIAL_ACTIONS = {
    [VaultErrorCode.ITEM_UNREADABLE]: "vault.item_unreadable",
    [VaultErrorCode.PERSISTENT_NOT_ALLOWED]: "vault.persistent_not_allowed",
};

const defaultAudit = (entry) => require("../../controllers/audit").createAuditLog(entry);
const callerKey = (ctx) => `${ctx.accountId}:${ctx.keyId ?? null}`;
const valueOf = (value, item) => (typeof value !== "function" ? value : item ? value(item) : null);
// Without updatedAt: an edit outside the stamped fields (description, username) does not stop a use the
// user has just approved. Session approvals still end on every edit, their stamp keeps updatedAt.
const useStamp = (item) => grantStamp({ id: item.id, fields: item.fields, updatedAt: 0 });
const REVOKED_MESSAGE = "The key of this connection was revoked while the approval was open; nothing was done.";
const staleEntry = () => new VaultError(VaultErrorCode.APPROVAL_STALE);

const createRateLimit = ({ windowMs, limit }) => {
    const calls = new Map();
    return (ctx) => {
        const now = Date.now();
        for (const [key, stamps] of calls) if (stamps.every((at) => now - at >= windowMs)) calls.delete(key);
        const key = callerKey(ctx);
        const recent = (calls.get(key) ?? []).filter((at) => now - at < windowMs);
        if (recent.length >= limit) throw new VaultError(VaultErrorCode.RATE_LIMITED);
        recent.push(now);
        calls.set(key, recent);
    };
};

const createBroker = ({ approvals = require("./approvals"), audit = defaultAudit } = {}) => {
    const rateAudited = new Map();

    const firstRefusalInWindow = (tool, ctx) => {
        const now = Date.now();
        for (const [key, at] of rateAudited) if (now - at >= RATE_AUDIT_WINDOW_MS) rateAudited.delete(key);
        const key = `${tool}:${callerKey(ctx)}`;
        if (rateAudited.has(key)) return false;
        rateAudited.set(key, now);
        return true;
    };

    const entryNameOf = async (agent) => {
        if (!agent?.entryId) return null;
        return (await Entry.findByPk(agent.entryId, { attributes: ["name"] }))?.name ?? null;
    };

    const keyStillValid = async (ctx) => ctx.keyId == null
        || (await ApiKey.count({ where: { id: ctx.keyId, accountId: ctx.accountId, pending: false } })) > 0;

    const record = (ctx, item, action, details) => audit({
        accountId: ctx.accountId,
        organizationId: item?.organizationId ?? null,
        action,
        resource: "vault",
        resourceId: item?.id ?? null,
        details,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
    });

    const use = async ({
        ctx, itemRef: ref, tool, access, target = null, scope = access, field, check, act, fieldLabel = null, allowSession = true,
        approved = null, precheck = null, stale = staleEntry, revoked = REVOKED_MESSAGE, lazySecret = false, deferUse = false, auditExtra = {},
    }) => {
        const caller = { accountId: ctx.accountId, agent: ctx.agent ?? null };
        const note = { item: typeof ref === "string" ? ref.slice(0, 200) : null, stage: "before_approval" };
        let item = null;
        let approval = null;
        let auditedByApprovals = false;
        let result;
        const details = () => ({
            item: note.item, target: valueOf(target, item) ?? null, tool, access, ...auditExtra,
            agentType: ctx.agent?.agentType ?? null, keyId: ctx.keyId ?? null, entryId: ctx.agent?.entryId ?? null,
        });
        const load = async () => {
            item = await findVisibleItem(caller, ref);
            note.item = itemRef(item);
        };
        try {
            if (precheck) await precheck();
            await load();
            const approving = approved === null && (Boolean(item.approvalRequired) || ctx.impersonatorId != null);
            await check(item, { phase: "before", approving });
            const scopeNow = valueOf(scope, item);
            if (approved !== null || approving || String(scopeNow).includes("|")) {
                const expected = approved ?? { itemId: item.id, stamp: useStamp(item) };
                const stampOf = approved ? grantStamp : useStamp;
                if (approved === null) {
                    // Waited for outside every session lock: runAgent allows 90 s, an approval 2 minutes.
                    // So the key, the entry and the tool's checks run again afterwards, with everything as it is now.
                    approval = await approvals.requestApproval({
                        accountId: ctx.accountId, keyId: ctx.keyId ?? null, transportId: ctx.transportId,
                        agentType: ctx.agent?.agentType ?? null, entryName: await entryNameOf(ctx.agent),
                        impersonated: Boolean(ctx.impersonatorId), item, target: valueOf(target, item), tool, access, scope: scopeNow,
                        field: valueOf(fieldLabel, item), allowSession: valueOf(allowSession, item) !== false, signal: ctx.signal,
                    }).catch((err) => {
                        // approvals.js audits answers, timeouts and withdrawn cards itself; only early refusals come back unaudited.
                        auditedByApprovals = APPROVAL_CODES.has(err?.code) && !err.details?.early;
                        throw err;
                    });
                }
                note.stage = "after_approval";
                if (ctx.signal?.aborted) throw new VaultError(VaultErrorCode.CLIENT_GONE);
                if (!(await keyStillValid(ctx)))
                    throw new VaultError(VaultErrorCode.ITEM_UNKNOWN, revoked);
                await load();
                if (item.id !== expected.itemId || stampOf(item) !== expected.stamp) throw stale(item);
                await check(item, { phase: "after", approving });
            }
            const fieldName = valueOf(field, item);
            const read = async () => {
                const secret = await readSecret(item.id, fieldName);
                if (secret === null) throw new VaultError(VaultErrorCode.NO_SECRET);
                return secret;
            };
            result = await act(lazySecret ? read : await read(), item);
        } catch (err) {
            if (!auditedByApprovals && (err?.code !== VaultErrorCode.RATE_LIMITED || firstRefusalInWindow(tool, ctx))) {
                if (err?.code === VaultErrorCode.ITEM_UNREADABLE) logger.warn("Vault entry unreadable", { itemId: item?.id ?? null });
                await record(ctx, item, DENIAL_ACTIONS[err?.code] ?? "vault.use_denied", {
                    ...details(), stage: note.stage, code: typeof err?.code === "string" ? err.code : "INTERNAL",
                });
            }
            throw err;
        }
        const used = item;
        const recordUse = async (more = {}) => {
            try {
                await record(ctx, used, "vault.use", { ...details(), ...more, approval });
            } catch (err) {
                logger.warn("Could not audit a completed vault use", { itemId: used.id, tool, error: err?.name });
            }
            // silent: updatedAt is part of the stamp of a session approval; touching it would end that approval after every use.
            await VaultItem.update({ lastUsedAt: new Date() }, { where: { id: used.id }, silent: true })
                .catch((err) => logger.warn("Could not record the last use of a vault entry", { itemId: used.id, error: err.message }));
        };
        if (deferUse) return { result, approval, item, recordUse };
        await recordUse();
        return { result, approval, item };
    };

    return { use };
};

let shared = null;
const use = (options) => (shared ??= createBroker()).use(options);

module.exports = { createBroker, createRateLimit, callerKey, use };

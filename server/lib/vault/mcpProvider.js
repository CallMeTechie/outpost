const { VaultError, VaultErrorCode } = require("./errors");
const { isVaultEnabled } = require("./state");
const { itemRef, visibleItems, findVisibleItem, canUseVault } = require("./visibility");
const { readSecret } = require("./secrets");
const { checkFillTarget, fillCredential, assertFillableSession, normalizeOrigin } = require("./fill");
const { defaultAudit } = require("../browser/tools");
const vaultGuard = require("../browser/vaultGuard");
const { BrowserError, BrowserErrorCode } = require("../browser/errors");
const permission = require("../../utils/permission");
const { Permission } = require("../../permissions/registry");
const VaultItem = require("../../models/VaultItem");
const ApiKey = require("../../models/ApiKey");
const Organization = require("../../models/Organization");
const Entry = require("../../models/Entry");
const logger = require("../../utils/logger");

const LIST = "vault_list";
const FILL = "browser_fill_credential";
const FILL_WINDOW_MS = 60 * 1000;
const FILL_LIMIT = 20;
const REF_PATTERN = /^e\d{1,9}$/;
const APPROVAL_CODES = new Set([
    VaultErrorCode.APPROVAL_TIMEOUT, VaultErrorCode.APPROVAL_UNAVAILABLE, VaultErrorCode.APPROVAL_PENDING,
    VaultErrorCode.APPROVAL_BUSY, VaultErrorCode.APPROVAL_DENIED, VaultErrorCode.CLIENT_GONE,
]);
const DENIAL_ACTIONS = {
    [VaultErrorCode.ITEM_UNREADABLE]: "vault.item_unreadable",
    [VaultErrorCode.PERSISTENT_NOT_ALLOWED]: "vault.persistent_not_allowed",
};

const TOOL_DEFS = [
    {
        name: LIST,
        description: "List the vault entries this connection may use. Never returns a secret value: per entry its id for browser_fill_credential (item), owner, type, username or host, origins or hosts, whether the user approves each use, and the tools that can use it (usableBy).",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: FILL,
        description: "Type a login entry from the vault into the password field, and optionally the username field, of a browser session. You never see the password: snapshots show it as ••••, and browser_evaluate stays locked in this browser context afterwards. The field's frame and all frames around it must be one of the entry's origins. If the entry needs approval, this call waits up to 2 minutes for the user.",
        inputSchema: {
            type: "object",
            properties: {
                item: { type: "string", description: "Entry id as vault_list shows it, e.g. github or org:3/shop" },
                passwordRef: { type: "string", description: "ref of the <input type=password> from the latest snapshot" },
                usernameRef: { type: "string", description: "ref of the username field (text, email or tel input); optional" },
                sessionId: { type: "string", description: "Browser session id. Defaults to the session this connection opened last; may be left out while only one session is open." },
            },
            required: ["item", "passwordRef"],
        },
    },
];

const textResult = (text) => ({ content: [{ type: "text", text }] });
const errorResult = (err) => ({
    isError: true,
    content: [{ type: "text", text: err instanceof VaultError ? `${err.message} (${err.code})` : err.message }],
});
const fieldsOf = (item) => item.fields ?? {};
const originsKey = (fields) => JSON.stringify((fields.origins ?? []).map(normalizeOrigin).sort());

const describeItem = (item, orgNames, canFill) => {
    const fields = fieldsOf(item);
    return {
        item: itemRef(item),
        owner: item.organizationId ? orgNames.get(item.organizationId) ?? `organization ${item.organizationId}` : "personal",
        type: item.type,
        description: item.description ?? null,
        ...(typeof fields.username === "string" && { username: fields.username }),
        ...(typeof fields.host === "string" && { host: fields.host }),
        ...(Array.isArray(fields.origins) && { origins: fields.origins.map(String) }),
        ...(Array.isArray(fields.hosts) && { hosts: fields.hosts.map(String) }),
        approvalRequired: !!item.approvalRequired,
        usableBy: item.type === "login" && canFill ? [FILL] : [],
    };
};

const assertFillArgs = ({ item, passwordRef, usernameRef, sessionId }) => {
    const invalid = (message) => new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, message);
    if (typeof item !== "string" || item.length === 0 || item.length > 200)
        throw invalid("item needs an entry id as vault_list shows it, e.g. github or org:3/shop");
    if (typeof passwordRef !== "string" || !REF_PATTERN.test(passwordRef))
        throw invalid("passwordRef needs the [ref=eN] of the password field from the latest snapshot");
    if (usernameRef != null && (typeof usernameRef !== "string" || !REF_PATTERN.test(usernameRef)))
        throw invalid("usernameRef, if given, needs the [ref=eN] of the username field from the latest snapshot");
    if (sessionId != null && typeof sessionId !== "string") throw invalid("sessionId needs a session id as browser_list shows it");
};

const createVaultProvider = ({ getBrowserTools, approvals = require("./approvals"), audit = defaultAudit }) => {
    const browserAllowed = new WeakMap();
    const recentFills = new Map();
    const rateAudited = new Map();

    const canUseBrowser = (accountId) => permission.hasAccountPermission(accountId, Permission.CONNECT_BROWSER);

    const sweep = (map, now) => {
        for (const [key, stamps] of map) {
            const live = [stamps].flat().filter((at) => now - at < FILL_WINDOW_MS);
            if (live.length === 0) map.delete(key);
        }
    };

    const assertFillRate = ({ accountId, keyId = null }) => {
        const key = `${accountId}:${keyId}`;
        const now = Date.now();
        sweep(recentFills, now);
        const recent = (recentFills.get(key) ?? []).filter((at) => now - at < FILL_WINDOW_MS);
        if (recent.length >= FILL_LIMIT)
            throw new VaultError(VaultErrorCode.RATE_LIMITED);
        recent.push(now);
        recentFills.set(key, recent);
    };

    const firstRefusalInWindow = ({ accountId, keyId = null }) => {
        const key = `${accountId}:${keyId}`;
        const now = Date.now();
        sweep(rateAudited, now);
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

    const describeCall = (note, ctx) => ({
        item: note.item, sessionId: note.sessionId, target: note.target,
        agentType: ctx.agent?.agentType ?? null, keyId: ctx.keyId ?? null, entryId: ctx.agent?.entryId ?? null,
    });

    const listItems = async (args, ctx) => {
        const items = await visibleItems({ accountId: ctx.accountId, agent: ctx.agent ?? null });
        const orgIds = [...new Set(items.map((item) => item.organizationId).filter(Boolean))];
        const orgs = orgIds.length > 0 ? await Organization.findAll({ where: { id: orgIds }, attributes: ["id", "name"] }) : [];
        const orgNames = new Map(orgs.map((org) => [org.id, org.name]));
        const canFill = await canUseBrowser(ctx.accountId);
        return textResult(items.length > 0
            ? JSON.stringify(items.map((item) => describeItem(item, orgNames, canFill)), null, 2)
            : "No vault entries are available to this connection.");
    };

    const fill = async (args, ctx) => {
        const note = { item: typeof args.item === "string" ? args.item.slice(0, 200) : null, sessionId: null, target: null, stage: "before_approval" };
        const caller = { accountId: ctx.accountId, agent: ctx.agent ?? null };
        const usernameRef = args.usernameRef ?? null;
        const refs = { passwordRef: args.passwordRef, usernameRef };
        let item = null;
        let fields = {};
        let session = null;
        let approval = null;
        let auditedByApprovals = false;
        const loadItem = async () => {
            item = await findVisibleItem(caller, args.item);
            fields = fieldsOf(item);
            note.item = itemRef(item);
            if (item.type !== "login")
                throw new VaultError(VaultErrorCode.WRONG_TYPE, `${note.item} is a ${item.type} entry; browser_fill_credential fills login entries only.`);
            if (usernameRef && !fields.username)
                throw new VaultError(VaultErrorCode.BAD_USERNAME_FIELD, `${note.item} stores no username; call again without usernameRef.`);
        };
        const locate = (sessionId) => getBrowserTools().resolveSession(ctx, sessionId);
        const verify = (current) => {
            assertFillableSession(current);
            return checkFillTarget(current, refs, fields.origins ?? []);
        };
        try {
            assertFillRate(ctx);
            assertFillArgs(args);
            await loadItem();
            session = locate(args.sessionId ?? null);
            Object.assign(note, { sessionId: session.id, target: normalizeOrigin(session.state.url) });
            if (item.approvalRequired || ctx.impersonatorId != null) {
                await session.runAgent(FILL, () => verify(session));
                // Waited for outside runAgent: its 90 s limit is shorter than the 2 minutes of an approval,
                // so every check runs again afterwards, with the entry and the key as they are now.
                approval = await approvals.requestApproval({
                    accountId: ctx.accountId, keyId: ctx.keyId ?? null, transportId: ctx.transportId,
                    agentType: ctx.agent?.agentType ?? null, entryName: await entryNameOf(ctx.agent),
                    impersonated: Boolean(ctx.impersonatorId), item, target: note.target, signal: ctx.signal,
                }).catch((err) => {
                    // approvals.js audits answers, timeouts and withdrawn cards itself; only early refusals come back unaudited.
                    auditedByApprovals = APPROVAL_CODES.has(err?.code) && !err.details?.early;
                    throw err;
                });
                note.stage = "after_approval";
                if (ctx.signal?.aborted) throw new VaultError(VaultErrorCode.CLIENT_GONE);
                if (!(await keyStillValid(ctx)))
                    throw new VaultError(VaultErrorCode.ITEM_UNKNOWN, "The key of this connection was revoked while the approval was open; nothing was filled.");
                const approvedOrigins = originsKey(fields);
                await loadItem();
                if (originsKey(fields) !== approvedOrigins)
                    throw new VaultError(VaultErrorCode.ORIGIN_MISMATCH,
                        `The origins of ${note.item} changed while the approval was open; nothing was filled. Call browser_fill_credential again so the user approves the entry as it is now.`);
                session = locate(session.id);
                note.target = normalizeOrigin(session.state.url);
            }
            await session.runAgent(FILL, async () => {
                const nodes = await verify(session);
                const password = await readSecret(item.id, "password");
                if (password === null)
                    throw new VaultError(VaultErrorCode.NO_SECRET);
                await fillCredential(session, { ...nodes, username: usernameRef ? fields.username : null, password });
            });
        } catch (err) {
            if (session && typeof err?.message === "string") err.message = vaultGuard.redactText(session.contextKey, err.message);
            if (!auditedByApprovals && (err?.code !== VaultErrorCode.RATE_LIMITED || firstRefusalInWindow(ctx))) {
                if (err?.code === VaultErrorCode.ITEM_UNREADABLE) logger.warn("Vault entry unreadable", { itemId: item?.id ?? null });
                await record(ctx, item, DENIAL_ACTIONS[err?.code] ?? "vault.use_denied", {
                    ...describeCall(note, ctx), stage: note.stage, code: typeof err?.code === "string" ? err.code : "INTERNAL",
                });
            }
            throw err;
        }
        try {
            await record(ctx, item, "vault.use", { ...describeCall(note, ctx), approval });
        } catch (err) {
            logger.warn("Could not audit a completed vault fill", { itemId: item.id, error: err?.name });
        }
        // silent: updatedAt is part of the stamp of a session approval (Task 6); touching it would end that approval after every fill.
        await VaultItem.update({ lastUsedAt: new Date() }, { where: { id: item.id }, silent: true })
            .catch((err) => logger.warn("Could not record the last use of a vault entry", { itemId: item.id, error: err.message }));
        return textResult(usernameRef ? `Benutzername und Passwort von ${note.item} eingetragen.` : `Passwort von ${note.item} eingetragen.`);
    };

    const handlers = { [LIST]: listItems, [FILL]: fill };

    return {
        name: "vault",
        available: async (ctx) => {
            if (!isVaultEnabled()) return false;
            const [canUse, browser] = await Promise.all([canUseVault(ctx.accountId), canUseBrowser(ctx.accountId)]);
            browserAllowed.set(ctx, browser);
            return canUse;
        },
        list: (ctx) => (browserAllowed.get(ctx) === true ? TOOL_DEFS : TOOL_DEFS.filter((tool) => tool.name !== FILL)),
        has: (name, ctx) => name === LIST || (name === FILL && browserAllowed.get(ctx) === true),
        call: async (name, args, ctx) => {
            try {
                if (!Object.hasOwn(handlers, name) || (name === FILL && !(await canUseBrowser(ctx.accountId))))
                    throw new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, `Unknown tool: ${name}`);
                return await handlers[name](args ?? {}, ctx);
            } catch (err) {
                if (err instanceof VaultError || err instanceof BrowserError) return errorResult(err);
                logger.warn("Vault tool failed", { tool: name, error: err.message });
                return errorResult(new BrowserError(BrowserErrorCode.INTERNAL, `${name} failed unexpectedly; try again.`));
            }
        },
        forgetTransport: (transportId) => approvals.forgetTransport(transportId),
    };
};

module.exports = { createVaultProvider };

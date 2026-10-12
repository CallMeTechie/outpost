const { VaultError, VaultErrorCode } = require("./errors");
const { isVaultEnabled } = require("./state");
const { itemRef, visibleItems, canUseVault } = require("./visibility");
const { checkFillTarget, fillCredential, assertFillableSession, normalizeOrigin } = require("./fill");
const { createBroker, createRateLimit } = require("./broker");
const { createHttpLimits } = require("./tools/http");
const fillSecret = require("./tools/fillSecret");
const { createSshLimits } = require("./sshUse");
const { resolveTarget } = require("./sshSession");
const { targetRefsOf, pinnedRefs } = require("./sshTargets");
const { getVaultSettings } = require("../../controllers/vaultSettings");
const { defaultAudit } = require("../browser/tools");
const vaultGuard = require("../browser/vaultGuard");
const { BrowserError, BrowserErrorCode } = require("../browser/errors");
const permission = require("../../utils/permission");
const { Permission } = require("../../permissions/registry");
const Organization = require("../../models/Organization");
const logger = require("../../utils/logger");

const LIST = "vault_list";
const FILL = "browser_fill_credential";
const HTTP = "vault_http";
const FILL_SECRET = "browser_fill_secret";
const SSH_EXEC = "ssh_exec";
const FILL_WINDOW_MS = 60 * 1000;
const FILL_LIMIT = 20;
const REF_PATTERN = /^e\d{1,9}$/;
const FILLABLE_TYPES = new Set(["api_key", "generic"]);

const textResult = (text) => ({ content: [{ type: "text", text }] });
const errorResult = (err) => ({
    isError: true,
    content: [{ type: "text", text: err instanceof VaultError ? `${err.message} (${err.code})` : err.message }],
});
const fieldsOf = (item) => item.fields ?? {};
const canUseBrowser = (accountId) => permission.hasAccountPermission(accountId, Permission.CONNECT_BROWSER);

const usableBy = (item, fields, { canFill, fillAnywhere, sshTargets }) => {
    const fillable = canFill && ((fields.fillOrigins ?? []).length > 0 || fillAnywhere.has(item.id));
    if (item.type === "login") return canFill ? [FILL] : [];
    if (item.type === "api_key") return [HTTP, ...(fields.git === true ? ["git"] : []), ...(fillable ? [FILL_SECRET] : [])];
    if (item.type === "generic") return fillable ? [FILL_SECRET] : [];
    if (item.type === "ssh") return sshTargets.get(item.id).length > 0 ? [SSH_EXEC] : [];
    return [];
};

const describeItem = (item, orgNames, abilities) => {
    const fields = fieldsOf(item);
    return {
        item: itemRef(item),
        owner: item.organizationId ? orgNames.get(item.organizationId) ?? `organization ${item.organizationId}` : "personal",
        type: item.type,
        description: item.description ?? null,
        ...(typeof fields.username === "string" && { username: fields.username }),
        ...(typeof fields.host === "string" && { host: fields.host }),
        ...(Array.isArray(fields.origins) && { origins: fields.origins.map(String) }),
        ...(Array.isArray(fields.hosts) && item.type !== "ssh" && { hosts: fields.hosts.map(String) }),
        ...(item.type === "api_key" && { readOnly: fields.readOnly === true, allowHttp: fields.allowHttp === true, git: fields.git === true }),
        ...(FILLABLE_TYPES.has(item.type) && { fillOrigins: (fields.fillOrigins ?? []).map(String) }),
        ...(item.type === "ssh" && { allowSession: fields.allowSession === true, targets: abilities.sshTargets.get(item.id) }),
        approvalRequired: !!item.approvalRequired,
        usableBy: usableBy(item, fields, abilities),
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

const sshTargetsOf = async (item, ctx, pinned) => {
    const targets = [];
    for (const ref of targetRefsOf(item)) {
        const target = await resolveTarget(item, ref, ctx, { withJumpHosts: false }).catch(() => null);
        if (target) targets.push({ ref, name: target.name, host: target.host, port: target.port, hostKeyKnown: pinned.has(`${item.id} ${ref}`) });
    }
    return targets;
};

const listItems = async (args, ctx) => {
    const items = await visibleItems({ accountId: ctx.accountId, agent: ctx.agent ?? null });
    const orgIds = [...new Set(items.map((item) => item.organizationId).filter(Boolean))];
    const orgs = orgIds.length > 0 ? await Organization.findAll({ where: { id: orgIds }, attributes: ["id", "name"] }) : [];
    const orgNames = new Map(orgs.map((org) => [org.id, org.name]));
    const canFill = await canUseBrowser(ctx.accountId);
    const fillAnywhere = new Set();
    const withoutOrigins = items.filter((item) => FILLABLE_TYPES.has(item.type) && (fieldsOf(item).fillOrigins ?? []).length === 0);
    if (canFill && withoutOrigins.length > 0 && (await getVaultSettings()).fillAnywhere === true) {
        for (const item of withoutOrigins) if (await fillSecret.mayFillAnywhere(item, ctx.accountId)) fillAnywhere.add(item.id);
    }
    const sshItems = items.filter((item) => item.type === "ssh");
    const pinned = sshItems.length > 0 ? await pinnedRefs(sshItems.map((item) => item.id)) : new Set();
    const sshTargets = new Map();
    for (const item of sshItems) sshTargets.set(item.id, await sshTargetsOf(item, ctx, pinned));
    return textResult(items.length > 0
        ? JSON.stringify(items.map((item) => describeItem(item, orgNames, { canFill, fillAnywhere, sshTargets })), null, 2)
        : "No vault entries are available to this connection.");
};

const fillLogin = async (args, ctx, { broker, getBrowserTools, fillRate }) => {
    const usernameRef = args.usernameRef ?? null;
    const refs = { passwordRef: args.passwordRef, usernameRef };
    const seen = { sessionId: null };
    let session = null;
    let origin = null;
    const locate = (sessionId) => {
        session = getBrowserTools().resolveSession(ctx, sessionId);
        seen.sessionId = session.id;
        origin = normalizeOrigin(session.state.url);
    };
    const verify = (item) => {
        assertFillableSession(session);
        return checkFillTarget(session, refs, fieldsOf(item).origins ?? []);
    };
    try {
        const { item } = await broker.use({
            ctx, itemRef: args.item, tool: FILL, access: "write", scope: "fill", field: "password", target: () => origin, auditExtra: seen, lazySecret: true,
            revoked: "The key of this connection was revoked while the approval was open; nothing was filled.",
            precheck: () => {
                fillRate(ctx);
                assertFillArgs(args);
            },
            check: async (item, { phase, approving }) => {
                const name = itemRef(item);
                if (item.type !== "login")
                    throw new VaultError(VaultErrorCode.WRONG_TYPE, `${name} is a ${item.type} entry; browser_fill_credential fills login entries only.`);
                if (usernameRef && !fieldsOf(item).username)
                    throw new VaultError(VaultErrorCode.BAD_USERNAME_FIELD, `${name} stores no username; call again without usernameRef.`);
                locate(phase === "before" ? args.sessionId ?? null : session.id);
                // Only so that a wrong field fails before the card opens; act checks again in the runAgent that types.
                if (phase === "before" && approving) await session.runAgent(FILL, () => verify(item));
            },
            stale: (item) => new VaultError(VaultErrorCode.ORIGIN_MISMATCH,
                `The origins of ${itemRef(item)} changed while the approval was open; nothing was filled. Call browser_fill_credential again so the user approves the entry as it is now.`),
            act: (readPassword, item) => session.runAgent(FILL, async () => {
                const nodes = await verify(item);
                const password = await readPassword();
                await fillCredential(session, { ...nodes, username: usernameRef ? fieldsOf(item).username : null, password });
            }),
        });
        return textResult(usernameRef ? `Filled username and password of ${itemRef(item)}.` : `Filled password of ${itemRef(item)}.`);
    } catch (err) {
        if (session && typeof err?.message === "string") err.message = vaultGuard.redactText(session.contextKey, err.message);
        throw err;
    }
};

const TOOLS = {
    [LIST]: {
        def: {
            name: LIST,
            description: "List the vault entries this connection may use. Never returns a secret value: per entry its id for the vault tools (item), owner, type, username or host, origins, hosts or SSH targets, whether the user approves each use, and the tools that can use it (usableBy).",
            inputSchema: { type: "object", properties: {} },
        },
        handler: listItems,
        needsBrowser: false,
    },
    [HTTP]: require("./tools/http"),
    [SSH_EXEC]: require("./tools/sshExec"),
    [FILL]: {
        def: {
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
        handler: fillLogin,
        needsBrowser: true,
    },
    [FILL_SECRET]: fillSecret,
};

const createVaultProvider = ({ getBrowserTools, approvals = require("./approvals"), audit = defaultAudit }) => {
    const browserAllowed = new WeakMap();
    const deps = {
        broker: createBroker({ approvals, audit }),
        getBrowserTools,
        approvals,
        audit,
        fillRate: createRateLimit({ windowMs: FILL_WINDOW_MS, limit: FILL_LIMIT }),
        httpLimits: createHttpLimits(),
        sshLimits: createSshLimits(),
    };
    const offered = (name, browser) => Object.hasOwn(TOOLS, name) && (!TOOLS[name].needsBrowser || browser);

    return {
        name: "vault",
        available: async (ctx) => {
            if (!isVaultEnabled()) return false;
            const [canUse, browser] = await Promise.all([canUseVault(ctx.accountId), canUseBrowser(ctx.accountId)]);
            browserAllowed.set(ctx, browser);
            return canUse;
        },
        list: (ctx) => Object.keys(TOOLS).filter((name) => offered(name, browserAllowed.get(ctx) === true)).map((name) => TOOLS[name].def),
        has: (name, ctx) => offered(name, browserAllowed.get(ctx) === true),
        call: async (name, args, ctx) => {
            try {
                const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
                if (!tool || (tool.needsBrowser && !(await canUseBrowser(ctx.accountId))))
                    throw new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, `Unknown tool: ${name}`);
                return await tool.handler(args ?? {}, ctx, deps);
            } catch (err) {
                if (err instanceof VaultError || err instanceof BrowserError) return errorResult(err);
                logger.warn("Vault tool failed", { tool: name, error: err.message });
                return errorResult(new BrowserError(BrowserErrorCode.INTERNAL, `${name} failed unexpectedly; try again.`));
            }
        },
        forgetTransport: (transportId) => approvals.forgetSession(transportId),
    };
};

module.exports = { createVaultProvider };

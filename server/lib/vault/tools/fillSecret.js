const { VaultError, VaultErrorCode } = require("../errors");
const { itemRef } = require("../visibility");
const { checkSecretTarget, typeInto, releaseObjects, assertFillableSession } = require("../fill");
const vaultGuard = require("../../browser/vaultGuard");
const { BrowserError, BrowserErrorCode } = require("../../browser/errors");
const { getVaultSettings } = require("../../../controllers/vaultSettings");

const TOOL = "browser_fill_secret";
const SECRET_FIELD = Object.freeze({ api_key: "token", generic: "value" });
const REF_PATTERN = /^e\d{1,9}$/;

const def = {
    name: TOOL,
    description: "Type the value of an API key or \"other\" entry into one field of a browser session, for example a token field in a web form. You never see the value: snapshots show ••••, browser_evaluate stays locked in this browser context afterwards, and screenshots stay locked while the value is visible in a field that is not a password field. The field's frame and all frames around it must be one of the entry's fill origins. Needs approval unless the entry says otherwise.",
    inputSchema: {
        type: "object",
        properties: {
            item: { type: "string", description: "Entry id as vault_list shows it, e.g. github-token or org:3/deploy-token" },
            ref: { type: "string", description: "ref of the field from the latest snapshot: a text, password, search or url input, or a textarea" },
            sessionId: { type: "string", description: "Browser session id. Defaults to the session this connection opened last; may be left out while only one session is open." },
        },
        required: ["item", "ref"],
    },
};

const assertArgs = ({ item, ref, sessionId }) => {
    const invalid = (message) => new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, message);
    if (typeof item !== "string" || item.length === 0 || item.length > 200)
        throw invalid("item needs an entry id as vault_list shows it, e.g. github-token or org:3/deploy-token");
    if (typeof ref !== "string" || !REF_PATTERN.test(ref))
        throw invalid("ref needs the [ref=eN] of the field from the latest snapshot");
    if (sessionId != null && typeof sessionId !== "string") throw invalid("sessionId needs a session id as browser_list shows it");
};

const fillOriginsOf = (item) => {
    const origins = item.fields?.fillOrigins ?? [];
    return origins.length > 0 ? origins : null;
};

const typeSecret = async (session, backendNodeId, secret) => {
    try {
        // markFilled checks the taint in the same synchronous step, directly before Input.insertText.
        await typeInto(session, backendNodeId, secret, () => {
            if (session.closed)
                throw new BrowserError(BrowserErrorCode.SESSION_CLOSED, `Session ${session.id} has ended; nothing was typed. Open a new session with browser_open and fill there.`);
            vaultGuard.markFilled(session.contextKey, { targetId: session.targetId, backendNodeIds: [backendNodeId], secret });
        });
    } finally {
        releaseObjects(session);
    }
};

const handler = async (args, ctx, deps) => {
    const auditExtra = {};
    let session = null;
    let field = null;
    const check = async (item, { phase }) => {
        if (!Object.hasOwn(SECRET_FIELD, item.type))
            throw new VaultError(VaultErrorCode.WRONG_TYPE, `${itemRef(item)} is a ${item.type} entry; browser_fill_secret fills API key and "other" entries only.`);
        if (fillOriginsOf(item) === null && !(await getVaultSettings()).fillAnywhere) throw new VaultError(VaultErrorCode.NO_FILL_ORIGINS);
        if (phase !== "before") return;
        session = deps.getBrowserTools().resolveSession(ctx, args.sessionId ?? null);
        field = await session.runAgent(TOOL, async () => {
            assertFillableSession(session);
            return checkSecretTarget(session, args.ref, fillOriginsOf(item));
        });
        Object.assign(auditExtra, { origin: field.origin, fieldType: field.fieldType });
    };
    // Waiting for the approval happens outside runAgent; act checks the session and the field again
    // and only then reads the secret, inside the runAgent that types.
    const act = async (read, item) => {
        session = deps.getBrowserTools().resolveSession(ctx, session.id);
        await session.runAgent(TOOL, async () => {
            assertFillableSession(session);
            const now = await checkSecretTarget(session, args.ref, fillOriginsOf(item));
            if (now.origin !== field.origin)
                throw new VaultError(VaultErrorCode.APPROVAL_STALE,
                    `The field moved from ${field.origin} to ${now.origin} after the check; nothing was filled. Take a new snapshot and call browser_fill_secret again.`);
            await typeSecret(session, now.backendNodeId, await read());
        });
        return `Filled the value of ${itemRef(item)} into the field.`;
    };
    try {
        const { result } = await deps.broker.use({
            ctx, itemRef: args.item, tool: TOOL, access: "write",
            precheck: () => {
                deps.fillRate(ctx);
                assertArgs(args);
            },
            // Also read for the audit of a refusal, before check has located the field.
            target: () => field?.origin ?? null,
            scope: (item) => (fillOriginsOf(item) === null ? `fill|${field.origin}` : "fill"),
            field: (item) => SECRET_FIELD[item.type],
            check, act, auditExtra, lazySecret: true,
        });
        return { content: [{ type: "text", text: result }] };
    } catch (err) {
        if (session && typeof err?.message === "string") err.message = vaultGuard.redactText(session.contextKey, err.message);
        throw err;
    }
};

module.exports = { def, handler, needsBrowser: true };

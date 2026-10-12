const { VaultError, VaultErrorCode } = require("./errors");
const { itemRef } = require("./visibility");
const { createCallLimits } = require("./broker");
const { variantsOf } = require("./redact");
const { readSecret } = require("./secrets");
const { targetRefsOf, pinnedKey, pinKey } = require("./sshTargets");
const { resolveTarget, assertEngine, probeHostKey, openTargetSession, sshParams, sshFailure, hostKeyChanged } = require("./sshSession");
const stateBroadcaster = require("../StateBroadcaster");
const { AUDIT_ACTIONS, RESOURCE_TYPES } = require("../../controllers/audit");

const NOTICE_WINDOW_MS = 60 * 1000;
const MIN_KEY_LINE = 16;
const KEY_FRAME = /^-----(BEGIN|END) /;

const createSshLimits = () => {
    const noticed = new Map();
    return {
        ...createCallLimits({ windowMs: 60_000, limit: 30, maxRunning: 2 }),
        firstNotice: (key) => {
            const now = Date.now();
            for (const [seen, at] of noticed) if (now - at >= NOTICE_WINDOW_MS) noticed.delete(seen);
            if (noticed.has(key)) return false;
            noticed.set(key, now);
            return true;
        },
    };
};

// A cat of the key prints it line by line, and a partial one never matches the key as a whole.
const keyLines = (key) => key.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= MIN_KEY_LINE && !KEY_FRAME.test(line));
const variantsFor = ({ password, passphrase, privateKey }) =>
    [password, passphrase, privateKey, ...(privateKey ? keyLines(privateKey) : [])].filter(Boolean).flatMap(variantsOf);

const readSecrets = async (itemId) => {
    const privateKey = await readSecret(itemId, "privateKey");
    const passphrase = await readSecret(itemId, "passphrase");
    const password = await readSecret(itemId, "password");
    if (!privateKey && !password) throw new VaultError(VaultErrorCode.NO_SECRET);
    return { privateKey, passphrase, password };
};

const hostLabel = (host) => (host.includes(":") ? `[${host}]` : host);

const sshUse = async (ctx, { broker, sshLimits, audit }, {
    item: itemArg, target: targetArg, tool, access, card = () => ({}), validate = () => {}, prepare = async () => {}, act, auditExtra = {},
}) => {
    const state = { target: null, pinned: null, probed: null };
    const hostKey = () => state.pinned ?? state.probed;
    let entered = null;

    const record = (item, action, details) => audit({
        accountId: ctx.accountId, organizationId: item.organizationId ?? null, action, resource: RESOURCE_TYPES.VAULT, resourceId: item.id,
        details: { item: itemRef(item), tool, keyId: ctx.keyId ?? null, target: state.target.ref, ...details },
        ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null,
    });

    const reportMismatch = async (item, { expected, actual }) => {
        await record(item, AUDIT_ACTIONS.VAULT_SSH_HOST_KEY_MISMATCH, { expected, actual });
        if (!sshLimits.firstNotice(`${ctx.accountId} ${item.id} ${state.target.ref} ${actual}`)) return;
        stateBroadcaster.push([ctx.accountId], stateBroadcaster.STATE_TYPES.VAULT_NOTICE,
            { kind: "ssh_host_key_mismatch", item: itemRef(item), target: state.target.ref, name: state.target.name });
    };

    const confirmHostKey = async (item) => {
        const shown = hostKey();
        const current = await pinnedKey(item.id, state.target.ref);
        if (!current && !state.probed) throw new VaultError(VaultErrorCode.APPROVAL_STALE);
        const stored = current ?? (await pinKey({ itemId: item.id, ref: state.target.ref, ...state.probed, accountId: ctx.accountId }));
        if (stored.fingerprint !== shown.fingerprint) {
            const changed = hostKeyChanged(state.target.ref, stored.fingerprint, shown.fingerprint);
            await reportMismatch(item, changed.details);
            throw changed;
        }
        if (!current) await record(item, AUDIT_ACTIONS.VAULT_SSH_HOST_KEY_PINNED, { algorithm: stored.algorithm, fingerprint: stored.fingerprint });
        state.pinned = stored;
    };

    try {
        const { result } = await broker.use({
            ctx, itemRef: itemArg, tool, access, lazySecret: true, auditExtra,
            target: (item) => (state.target
                ? `${state.target.name} · ${item.fields?.username ?? ""}@${hostLabel(state.target.host)}:${state.target.port}`
                : null),
            scope: () => `${access}#${state.target.ref}#${hostKey().fingerprint}`,
            allowSession: (item) => item.fields?.allowSession === true,
            forceApproval: () => state.probed !== null,
            card: (item) => ({
                sshTarget: { ref: state.target.ref, name: state.target.name, user: item.fields?.username ?? null, host: state.target.host, port: state.target.port },
                ...card(item),
                ...(state.probed && { hostKey: { ...state.probed, new: true } }),
            }),
            check: async (item, { phase }) => {
                if (item.type !== "ssh")
                    throw new VaultError(VaultErrorCode.WRONG_TYPE, `${itemRef(item)} is a ${item.type} entry; ${tool} uses SSH entries only.`);
                if (targetRefsOf(item).length === 0) throw new VaultError(VaultErrorCode.NO_TARGETS);
                state.target = await resolveTarget(item, targetArg, ctx);
                Object.assign(auditExtra, { target: state.target.ref, host: state.target.host, port: state.target.port, user: item.fields?.username ?? null });
                await validate(item);
                if (phase === "after") return confirmHostKey(item);
                sshLimits.rate(ctx);
                assertEngine(state.target);
                await prepare(item, state.target);
                state.pinned = await pinnedKey(item.id, state.target.ref);
                if (!state.pinned) state.probed = await probeHostKey(state.target, item.fields?.username);
            },
            act: async (_unused, item) => {
                // Taken only now: a call waiting for the user's approval does not hold one of the 2 slots.
                entered = sshLimits.enter(ctx);
                try {
                    const secrets = await readSecrets(item.id);
                    const params = sshParams(item, secrets);
                    const open = (options = {}) => {
                        const expectedHostKey = hostKey()?.fingerprint;
                        if (!expectedHostKey) throw new VaultError(VaultErrorCode.APPROVAL_STALE);
                        return openTargetSession(state.target, params, { ...options, expectedHostKey });
                    };
                    return await act({ item, target: state.target, open, variants: variantsFor(secrets) });
                } catch (err) {
                    if (err?.code === VaultErrorCode.HOST_KEY_CHANGED && err.details?.actual) await reportMismatch(item, err.details);
                    throw sshFailure(err, state.target, ctx.signal);
                }
            },
        });
        return result;
    } finally {
        if (entered) sshLimits.leave(entered);
    }
};

module.exports = { createSshLimits, sshUse };

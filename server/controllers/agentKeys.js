const crypto = require("node:crypto");
const net = require("node:net");
const { Op } = require("sequelize");
const ApiKey = require("../models/ApiKey");
const Entry = require("../models/Entry");
const Identity = require("../models/Identity");
const VaultSettings = require("../models/VaultSettings");
const { generateToken, hashToken, TOKEN_PREFIX } = require("./apiKey");
const { execCommand } = require("./execCommand");
const { validateEntryAccess, resolveEntryScope } = require("./entry");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("./audit");
const { resolveIdentity } = require("../utils/identityResolver");
const { normalizeIp } = require("../utils/ip");
const { canUseVault } = require("../lib/vault/visibility");
const { isAddressAllowed } = require("../lib/vault/ipBinding");
const provision = require("../lib/vault/provision");
const logger = require("../utils/logger");

const PENDING_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const REGISTRATION_MARKERS = new Set(["REMOVED", "FOREIGN", "ABSENT"]);
const GONE = { code: 410, message: "This setup has expired. Set up agent access again." };
const setupsInFlight = new Set();

const identityOf = (result) => (result?.identity === undefined ? result : result.identity);
const keyPrefixOf = (key) => key.prefix.replace(/…$/, "");
const hostCidr = (ip) => `${ip}/${net.isIP(ip) === 6 ? 128 : 32}`;
const endpoint = (agentUrl, path) => `${agentUrl.replace(/\/+$/, "")}${path}`;
const outputLines = (stdout) => String(stdout ?? "").split(/\r?\n/).map((line) => line.trim());
const cidrsOf = (value) => (Array.isArray(value) ? value : []);
const expired = (key, now) => now - new Date(key.createdAt).getTime() > PENDING_TTL_MS;
const manualCommand = (agentType, agentUrl, token) =>
    ` ${provision.setupCommand({ agentType, cliPath: agentType, url: endpoint(agentUrl, "/api/mcp"), key: token })}`;

const serialize = (key, entryNames) => ({
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    agentType: key.agentType,
    pending: key.pending,
    entryId: key.entryId,
    entryName: entryNames.get(key.entryId) ?? null,
    remoteUser: key.remoteUser,
    ipBinding: key.ipBinding,
    allowedCidrs: cidrsOf(key.allowedCidrs),
    agentUrl: key.agentUrl ?? null,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
});

const findEntry = async (accountId, entryId) => {
    const entry = await Entry.findByPk(entryId);
    if (!entry || !(await validateEntryAccess(accountId, entry)).valid) return null;
    return entry;
};

const remoteIdentity = async (entry, accountId) => identityOf(await resolveIdentity(entry, null, null, accountId)) || null;

// Never log stdout or stderr: the setup commands echo the key back on some CLIs.
const runRemote = async (accountId, entry, identityId, command) => {
    try {
        const result = await execCommand(accountId, entry.id, identityId, command, { engineId: entry.config?.engineId ?? null });
        if (result?.code || !result.success) return { ran: false, exitCode: null, stdout: "" };
        return { ran: true, exitCode: result.exitCode, stdout: result.stdout };
    } catch (err) {
        logger.warn("Agent key command could not run", { entryId: entry.id, error: err.message });
        return { ran: false, exitCode: null, stdout: "" };
    }
};

const probeResult = async (keyId, entry) => {
    const key = await ApiKey.findByPk(keyId);
    if (!key?.seenIp) return null;
    return { seenIp: key.seenIp, matches: await isAddressAllowed(key, entry, key.seenIp) };
};

const auditRevoke = async (key, entry, registration, { ipAddress = null, userAgent = null } = {}) => createAuditLog({
    accountId: key.accountId, organizationId: entry ? (await resolveEntryScope(entry)).organizationId ?? null : null,
    action: AUDIT_ACTIONS.VAULT_AGENT_KEY_REVOKE, resource: RESOURCE_TYPES.VAULT, resourceId: null,
    details: {
        keyId: key.id, agentType: key.agentType, entryId: key.entryId, entryName: entry?.name ?? null,
        remoteUser: key.remoteUser, registration, pending: key.pending,
    },
    ipAddress, userAgent,
});

const finalize = async (key, entry, context) => {
    const [updated] = await ApiKey.update({ pending: false }, { where: { id: key.id, pending: true } });
    if (!updated) return false;
    const replaced = await ApiKey.findAll({
        where: {
            accountId: key.accountId, kind: "agent", pending: false, entryId: key.entryId,
            agentType: key.agentType, remoteUser: key.remoteUser, id: { [Op.ne]: key.id },
        },
    });
    if (replaced.length > 0) {
        await ApiKey.destroy({ where: { id: replaced.map((old) => old.id) } });
        await Promise.all(replaced.map((old) => auditRevoke(old, entry, "replaced", context)));
    }
    return true;
};

const setupAgent = async ({ accountId, entry, identity, agentUrl, key, token }) => {
    const url = endpoint(agentUrl, "/api/mcp");
    const keyPrefix = keyPrefixOf(key);
    const keyFile = `key-${key.id}-${crypto.randomBytes(8).toString("hex")}`;
    const manual = (reason, probe = null, replacedRegistration = false) => ({
        status: "manual", reason, probe, replacedRegistration, command: manualCommand(key.agentType, agentUrl, token),
    });
    if (!identity) return manual("exec_failed");

    const run = (command) => runRemote(accountId, entry, identity.id, command);
    const cleanup = () => run(provision.keyCleanupCommand({ keyFile }));

    const drop = await run(provision.keyDropCommand({ keyFile, key: token }));
    if (!drop.ran || drop.exitCode !== 0) {
        await cleanup();
        return manual("exec_failed");
    }

    let finished = false;
    try {
        await run(provision.probeCommand({ url: endpoint(agentUrl, "/api/vault/agent-keys/probe"), keyFile }));
        const probe = await probeResult(key.id, entry);

        const found = await run(provision.findCliCommand(key.agentType));
        if (!found.ran) return manual("exec_failed", probe);
        const cliPath = found.exitCode === 0 ? outputLines(found.stdout).filter((line) => line.startsWith("/")).pop() : null;
        if (!cliPath) return manual("cli_missing", probe);

        const setup = await run(provision.setupCommand({ agentType: key.agentType, cliPath, url, keyFile }));
        const replacedRegistration = outputLines(setup.stdout).includes("OUTPOST_REPLACED=1");
        const configured = { status: "configured", reason: null, probe, replacedRegistration };
        if (setup.ran && setup.exitCode === 0) {
            finished = true;
            return configured;
        }
        if (!setup.ran) {
            // An exec error or timeout says nothing about the remote side: the setup may have gone through.
            const check = await run(provision.registrationCheckCommand({ agentType: key.agentType, keyPrefix }));
            if (check.ran && outputLines(check.stdout).includes("MATCH")) return configured;
        }
        return manual("exec_failed", probe, replacedRegistration);
    } finally {
        if (!finished) await cleanup();
    }
};

const setupOne = async ({ accountId, entry, identity, organizationId, agentUrl, attempt, ipBinding, allowedCidrs, context }) => {
    const { agentType, token } = attempt;
    const remoteUser = identity?.username || null;
    const key = await ApiKey.create({
        accountId, name: `${agentType}@${entry.name}`, tokenHash: hashToken(token),
        prefix: `${token.slice(0, TOKEN_PREFIX.length + 6)}…`, kind: "agent", pending: true,
        entryId: entry.id, agentType, ipBinding, allowedCidrs: allowedCidrs.length > 0 ? allowedCidrs : null,
        identityId: identity?.id ?? null, remoteUser, agentUrl,
    });
    try {
        await createAuditLog({
            accountId, organizationId, action: AUDIT_ACTIONS.VAULT_AGENT_KEY_CREATE,
            resource: RESOURCE_TYPES.VAULT, resourceId: null,
            details: { keyId: key.id, agentType, entryId: entry.id, entryName: entry.name, remoteUser, ipBinding, agentUrl },
            ...context,
        });
    } catch (err) {
        await ApiKey.destroy({ where: { id: key.id } });
        throw err;
    }
    attempt.key = key;

    const outcome = await setupAgent({ accountId, entry, identity, agentUrl, key, token });
    if (outcome.status === "configured") await finalize(key, entry, context);
    return { id: key.id, agentType, remoteUser, ...outcome };
};

const createAgentKeys = async ({
    accountId, entryId, agentTypes, agentUrl: requestedUrl = null, ipBinding: requestedBinding,
    allowedCidrs = [], ipAddress = null, userAgent = null,
}) => {
    const settings = await VaultSettings.getOrCreate();
    const agentUrl = requestedUrl || settings.agentUrl;
    if (!agentUrl) return { code: 409, message: "Enter the Outpost address for agents, here or in Settings › Vault" };
    const ipBinding = requestedBinding ?? settings.ipBindingDefault !== false;
    if (!(await canUseVault(accountId))) return { code: 403, message: "You are not allowed to set up agent access" };

    const entry = await findEntry(accountId, entryId);
    if (!entry) return { code: 404, message: "Entry not found" };
    if (entry.config?.protocol !== "ssh") return { code: 400, message: "Agent access needs an SSH server" };
    if (setupsInFlight.has(entry.id)) return { code: 409, message: "Agent access for this server is already being set up" };

    setupsInFlight.add(entry.id);
    try {
        const identity = await remoteIdentity(entry, accountId);
        const organizationId = (await resolveEntryScope(entry)).organizationId ?? null;
        const shared = { accountId, entry, identity, organizationId, agentUrl, ipBinding, allowedCidrs, context: { ipAddress, userAgent } };
        const attempts = agentTypes.map((agentType) => ({ agentType, token: generateToken(), key: null }));
        const settled = await Promise.allSettled(attempts.map((attempt) => setupOne({ ...shared, attempt })));
        return { results: settled.map(({ status, value, reason }, i) => {
            if (status === "fulfilled") return value;
            const { agentType, token, key } = attempts[i];
            logger.warn("Agent setup failed", { entryId: entry.id, agentType, error: reason?.name });
            return {
                id: key?.id ?? null, agentType, remoteUser: identity?.username || null,
                status: "manual", reason: "exec_failed", probe: null, replacedRegistration: false,
                ...(key ? { command: manualCommand(agentType, agentUrl, token) } : {}),
            };
        }) };
    } finally {
        setupsInFlight.delete(entry.id);
    }
};

const probe = async (apiKey, rawIp) => {
    const seenIp = normalizeIp(rawIp);
    await ApiKey.update({ seenIp }, { where: { id: apiKey.id, kind: "agent", pending: true, seenIp: null } });
    return { seenIp };
};

const confirm = async (accountId, id, { addSeenIp = false } = {}, { ipAddress = null, userAgent = null } = {}, now = Date.now()) => {
    const key = await ApiKey.findOne({ where: { id, accountId, kind: "agent" } });
    if (!key) return { code: 404, message: "Agent key not found" };
    if (key.pending && expired(key, now)) return GONE;

    if (addSeenIp) {
        if (!key.seenIp) return { code: 409, message: "No measured address to adopt" };
        if (normalizeIp(ipAddress) === key.seenIp)
            return { code: 409, message: "The measured address is the address of your browser; Outpost sees a proxy, not the server" };
        if (expired(key, now)) return { code: 409, message: "The measured address can only be adopted within 15 minutes of the setup" };
        const allowedCidrs = [...new Set([...cidrsOf(key.allowedCidrs), hostCidr(key.seenIp)])];
        const [updated] = await ApiKey.update({ allowedCidrs, seenIpAdopted: true }, { where: { id: key.id, seenIpAdopted: false } });
        if (!updated) return (await ApiKey.count({ where: { id: key.id } })) > 0
            ? { code: 409, message: "The measured address was already adopted" } : GONE;
    }

    if (key.pending && !(await finalize(key, await Entry.findByPk(key.entryId), { ipAddress, userAgent })))
        return (await ApiKey.count({ where: { id: key.id, pending: false } })) > 0 ? { success: true } : GONE;
    return { success: true };
};

const parseRegistration = (stdout) => {
    const marker = outputLines(stdout).filter((line) => REGISTRATION_MARKERS.has(line)).pop();
    return marker ? marker.toLowerCase() : "unknown";
};

const revoke = async (accountId, id, { ipAddress = null, userAgent = null } = {}) => {
    const key = await ApiKey.findOne({ where: { id, accountId, kind: "agent" } });
    if (!key) return { code: 404, message: "Agent key not found" };
    await ApiKey.destroy({ where: { id: key.id } });

    const entry = await Entry.findByPk(key.entryId);
    let registration = "absent";
    let commands = null;
    if (!key.pending) {
        const command = provision.revokeCommands({ agentType: key.agentType, keyPrefix: keyPrefixOf(key) });
        const identity = key.identityId ? await Identity.findByPk(key.identityId) : null;
        const result = entry && identity ? await runRemote(accountId, entry, identity.id, command) : { ran: false, stdout: "" };
        registration = result.ran ? parseRegistration(result.stdout) : "unknown";
        if (registration === "unknown") commands = command;
    }

    await auditRevoke(key, entry, registration, { ipAddress, userAgent });
    return commands ? { success: true, registration, commands } : { success: true, registration };
};

const listAgentKeys = async (accountId, { entryId = null } = {}) => {
    const entry = entryId ? await findEntry(accountId, entryId) : null;
    if (entryId && !entry) return { code: 404, message: "Entry not found" };

    const keys = await ApiKey.findAll({
        where: { accountId, kind: "agent", pending: false, ...(entry ? { entryId: entry.id } : {}) },
        order: [["createdAt", "DESC"]],
    });
    const entryIds = [...new Set(keys.map((key) => key.entryId))];
    const entries = entryIds.length > 0 ? await Entry.findAll({ where: { id: entryIds }, attributes: ["id", "name"] }) : [];
    const names = new Map(entries.map((row) => [row.id, row.name]));
    const result = { keys: keys.map((key) => serialize(key, names)) };
    if (!entry) return result;

    const remoteUser = (await remoteIdentity(entry, accountId))?.username || null;
    const otherAccountConfigured = !!remoteUser && (await ApiKey.count({
        where: { kind: "agent", pending: false, entryId: entry.id, remoteUser, accountId: { [Op.ne]: accountId } },
    })) > 0;
    return { ...result, remoteUser, otherAccountConfigured };
};

const sweepPending = async (now = Date.now()) => ApiKey.destroy({
    where: { kind: "agent", pending: true, createdAt: { [Op.lt]: new Date(now - PENDING_TTL_MS) } },
});

const startPendingSweeper = () => {
    const timer = setInterval(() => {
        sweepPending().catch((err) => logger.warn("Pending agent key sweep failed", { error: err.message }));
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
    return timer;
};

module.exports = { createAgentKeys, probe, confirm, revoke, listAgentKeys, sweepPending, startPendingSweeper, PENDING_TTL_MS };

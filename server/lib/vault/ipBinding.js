const dns = require("node:dns");
const net = require("node:net");
const { normalizeIp } = require("../../utils/ip");

const RESOLVE_TTL_MS = 60 * 1000;
const DENIAL_AUDIT_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TRACKED_DENIALS = 10000;

const resolved = new Map();
const deniedAt = new Map();

const familyOf = (ip) => ({ 4: "ipv4", 6: "ipv6" })[net.isIP(ip)];

const matchesCidr = (ip, cidr) => {
    const [network, prefixText, ...rest] = String(cidr).split("/");
    const family = familyOf(network);
    if (rest.length || !family || family !== familyOf(ip)) return false;
    const maxPrefix = family === "ipv4" ? 32 : 128;
    if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return false;
    const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
    if (prefix > maxPrefix) return false;
    const list = new net.BlockList();
    list.addSubnet(network, prefix, family);
    return list.check(ip, family);
};

const resolveHostAddresses = async (host) => {
    if (!host || typeof host !== "string") return [];
    const name = host.trim();
    if (net.isIP(name)) return [normalizeIp(name)];

    const cached = resolved.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.addresses;

    const addresses = dns.promises.lookup(name, { all: true })
        .then((results) => results.map((result) => normalizeIp(result.address)), () => []);
    resolved.set(name, { addresses, expiresAt: Date.now() + RESOLVE_TTL_MS });
    return addresses;
};

const allowedCidrsOf = (apiKey) => (Array.isArray(apiKey.allowedCidrs) ? apiKey.allowedCidrs : []);

const recordDenial = async (apiKey, entry, ip) => {
    const key = `${apiKey.id}|${ip}`;
    const now = Date.now();
    if (deniedAt.get(key) > now - DENIAL_AUDIT_INTERVAL_MS) return;

    if (deniedAt.size >= MAX_TRACKED_DENIALS) {
        for (const [tracked, at] of deniedAt) if (at <= now - DENIAL_AUDIT_INTERVAL_MS) deniedAt.delete(tracked);
    }
    deniedAt.set(key, now);

    // Lazy like defaultAudit in lib/browser/tools.js: auth.js loads this module, and tests that fake
    // utils/database without define() load auth.js.
    const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("../../controllers/audit");
    await createAuditLog({
        accountId: apiKey.accountId,
        action: AUDIT_ACTIONS.VAULT_AGENT_IP_DENIED,
        resource: RESOURCE_TYPES.VAULT,
        details: { keyId: apiKey.id, agentType: apiKey.agentType, entryId: apiKey.entryId, entryName: entry?.name ?? null, ip },
        ipAddress: ip,
    });
};

const isAddressAllowed = async (apiKey, entry, rawIp) => {
    if (!apiKey.ipBinding) return true;

    const ip = normalizeIp(rawIp);
    if (!familyOf(ip)) return false;
    if (allowedCidrsOf(apiKey).some((cidr) => matchesCidr(ip, cidr))) return true;
    return (await resolveHostAddresses(entry?.config?.ip)).some((address) => matchesCidr(ip, address));
};

const checkAgentIp = async (apiKey, entry, rawIp) => {
    if (await isAddressAllowed(apiKey, entry, rawIp)) return true;

    await recordDenial(apiKey, entry, normalizeIp(rawIp));
    return false;
};

const _resetForTests = () => {
    resolved.clear();
    deniedAt.clear();
};

module.exports = { isAddressAllowed, checkAgentIp, matchesCidr, resolveHostAddresses, _resetForTests };

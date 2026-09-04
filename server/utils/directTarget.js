/**
 * A one-off connection target, shaped like an Entry but never stored.
 *
 * Everything below createSession works on an entry OBJECT rather than on a
 * database row: ConnectionService reads config.ip, config.port and
 * config.protocol, resolveIdentity reads type, and the SSH handler reads
 * config.engineId. Handing them this object is enough, which is why a direct
 * connection needs no changes in any protocol handler.
 *
 * id is null on purpose. It flows into the audit record and into
 * SessionManager, and a fake numeric id there would collide with a real entry.
 */
const buildTransientEntry = (target) => ({
    id: null,
    name: `${target.host}:${target.port}`,
    type: "server",
    organizationId: null,
    folderId: null,
    // "terminal", not "xterm": that is the value the view's renderer switch
    // knows (ViewContainer) and the one entry.js gives a plain SSH entry.
    renderer: "terminal",
    config: { ip: target.host, port: target.port, protocol: target.protocol },
});

module.exports = { buildTransientEntry };

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const identityResolver = require("../../utils/identityResolver");
const Entry = require("../../models/Entry");
const SessionManager = require("../SessionManager");
const controlPlane = require("../controlPlane/ControlPlaneServer");

// Patched before ConnectionService is required: it destructures this at load time.
identityResolver.resolveIdentity = async () => ({ identity: null });

const { createConnectionForSession } = require("../ConnectionService");
const { createSessionValidation } = require("../../validations/serverSession");

const handshakeFor = async (displayDpi) => {
    const written = [];
    const socket = new EventEmitter();
    socket.write = (data) => {
        written.push(data);
        if (data.startsWith("6.select")) {
            setImmediate(() => socket.emit("data", "4.args,13.VERSION_1_5_0,8.hostname,3.dpi;"));
        } else if (data.startsWith("7.connect")) {
            setImmediate(() => socket.emit("data", "5.ready,4.$abc;"));
        }
    };

    const session = { accountId: 1, entryId: 9, auditLogId: null, generation: 1, engineSessionId: "s1", configuration: { displayDpi } };
    const stubs = [
        [SessionManager, "get", () => session],
        [SessionManager, "setGuacReady", () => {}],
        [SessionManager, "setConnection", () => true],
        [SessionManager, "updateConnectionId", () => {}],
        [SessionManager, "onMasterConnectionClosed", () => {}],
        [Entry, "findByPk", async () => ({ id: 9, type: "server", organizationId: null, config: { protocol: "rdp", ip: "10.0.0.5" } })],
        [controlPlane, "hasEngine", () => true],
        [controlPlane, "openSession", async () => {}],
        [controlPlane, "waitForDataConnection", async () => socket],
    ];
    const originals = stubs.map(([obj, key, fn]) => { const o = obj[key]; obj[key] = fn; return [obj, key, o]; });
    try {
        await createConnectionForSession("s1", 1);
    } finally {
        originals.forEach(([obj, key, o]) => { obj[key] = o; });
        socket.emit("close");
    }

    const size = written.find((w) => w.startsWith("4.size"));
    const connect = written.find((w) => w.startsWith("7.connect"));
    return { size, dpiArg: connect.split(",")[3].replace(/;$/, "") };
};

test("the client's display DPI reaches guacd, held to the range RDP scaling accepts", async () => {
    const retina = await handshakeFor(192);
    assert.strictEqual(retina.size, "4.size,4.1024,3.768,3.192;");
    assert.strictEqual(retina.dpiArg, "3.192");

    assert.strictEqual((await handshakeFor(null)).dpiArg, "2.96");
    assert.strictEqual((await handshakeFor(72)).dpiArg, "2.96");
    assert.strictEqual((await handshakeFor(1000)).dpiArg, "3.480");

    assert.ok(createSessionValidation.validate({ entryId: 1, displayDpi: 192 }).error === undefined);
    for (const displayDpi of [1.5, 0, 4800, "high"]) {
        assert.ok(createSessionValidation.validate({ entryId: 1, displayDpi }).error, `expected refusal for ${displayDpi}`);
    }
});

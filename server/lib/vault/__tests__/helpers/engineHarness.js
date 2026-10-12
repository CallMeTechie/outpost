const net = require("node:net");
const dgram = require("node:dgram");
const { spawn, execFileSync } = require("node:child_process");
const { Sequelize } = require("sequelize");

const NAS = process.env.OUTPOST_SSH_E2E_NAS || "ma.backes@192.168.2.151";
const NAS_KEY = process.env.OUTPOST_SSH_E2E_NAS_KEY || `${process.env.HOME}/.ssh/synology-manager-plus_ed25519`;
const DOCKER = "sudo -n /usr/local/bin/docker";
const ENGINE_CONTAINER = "outpost-engine-e2e";

const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const onNas = (command) => execFileSync("ssh", ["-i", NAS_KEY, "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", NAS, command],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

const freePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

// The address this machine uses towards the NAS is the one an engine there can reach it on.
const localAddressTowards = (host) => new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", reject);
    socket.connect(9, host, () => {
        const { address } = socket.address();
        socket.close();
        resolve(address);
    });
});

const nasHost = () => NAS.split("@").pop();

const start = async (engineSpec) => {
    fake("../../../../controllers/engine", { findByToken: async () => ({ id: 1, name: "e2e" }), updateLastConnected: async () => {} });
    fake("../../../../utils/database", new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false }));

    const docker = engineSpec.startsWith("docker:");
    const advertised = docker ? await localAddressTowards(nasHost()) : "127.0.0.1";
    process.env.CONTROL_PLANE_HOST = docker ? "0.0.0.0" : "127.0.0.1";
    process.env.CONTROL_PLANE_PORT = String(await freePort());
    const controlPlane = require("../../../controlPlane/ControlPlaneServer");
    await controlPlane.start();

    const connected = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("engine did not connect within 30 s")), 30000);
        controlPlane.once("engineConnected", (event) => { clearTimeout(timer); resolve(event); });
    });

    let child = null;
    if (docker) {
        const image = engineSpec.slice("docker:".length);
        onNas(`${DOCKER} rm -f ${ENGINE_CONTAINER} >/dev/null 2>&1; ${DOCKER} run -d --rm --name ${ENGINE_CONTAINER} --network host `
            + `-e REGISTRATION_TOKEN=e2e ${image} -h ${advertised} -p ${process.env.CONTROL_PLANE_PORT}`);
    } else {
        child = spawn(engineSpec, ["-h", advertised, "-p", process.env.CONTROL_PLANE_PORT], {
            env: { ...process.env, REGISTRATION_TOKEN: "e2e" }, stdio: "ignore",
        });
    }

    try {
        await connected;
    } catch (err) {
        if (docker) err.message += `\n${(() => { try { return onNas(`${DOCKER} logs ${ENGINE_CONTAINER} 2>&1`); } catch { return ""; } })()}`;
        stop();
        throw err;
    }

    function stop() {
        controlPlane.stop();
        if (child) child.kill("SIGTERM");
        if (docker) {
            try { onNas(`${DOCKER} rm -f ${ENGINE_CONTAINER} >/dev/null 2>&1`); } catch {}
        }
    }

    // sshd of the linuxserver image logs through s6 into /config/logs, not to stdout.
    const sshdLogLines = (target) => {
        const port = target.split(":").pop();
        const id = onNas(`${DOCKER} ps -q --filter publish=${port}`).trim();
        if (!id) throw new Error(`no sshd container publishes port ${port}`);
        const out = onNas(`${DOCKER} exec ${id} cat /config/logs/openssh/current 2>/dev/null || ${DOCKER} logs ${id} 2>&1`);
        return out.split("\n").filter(Boolean);
    };

    return { stop, sshdLogLines };
};

module.exports = { start };

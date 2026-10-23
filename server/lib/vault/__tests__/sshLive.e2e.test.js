const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const crypto = require("node:crypto");

const ENGINE = process.env.OUTPOST_SSH_E2E_ENGINE;
const TARGET = process.env.OUTPOST_SSH_E2E_TARGET;
const NOSFTP = process.env.OUTPOST_SSH_E2E_NOSFTP;
const skip = !ENGINE || !TARGET ? "set OUTPOST_SSH_E2E_ENGINE and OUTPOST_SSH_E2E_TARGET" : false;

const [host, port] = (TARGET || "").split(":");
const target = (h, p) => ({ ref: `host:${h}:${p}`, kind: "host", name: h, host: h, port: Number(p), jumpHosts: [], engineId: null });
const params = { username: "vault", password: process.env.OUTPOST_SSH_E2E_PASSWORD || "vault-e2e" };

const KEYSCAN_TYPE = { "ssh-ed25519": "ed25519", "ecdsa-sha2-nistp256": "ecdsa", "ecdsa-sha2-nistp384": "ecdsa", "ecdsa-sha2-nistp521": "ecdsa", "ssh-rsa": "rsa" };
const keyscan = (h, p, algorithm) => {
    const line = execFileSync("ssh-keyscan", ["-p", p, "-t", KEYSCAN_TYPE[algorithm], h], { encoding: "utf8" }).trim().split("\n").pop();
    const blob = Buffer.from(line.split(" ")[2], "base64");
    return `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
};

const sha256Of = async (client, path) => {
    const hash = crypto.createHash("sha256");
    const { stream, done } = client.readFile(path);
    for await (const chunk of stream) hash.update(chunk);
    await done;
    return hash.digest("hex");
};

const putThroughOutpost = (sshTransfer, { from, to, sourcePath, targetPath, mode, overwrite = false }) =>
    sshTransfer._copy({ from, to, sourcePath, targetPath, mode, overwrite, signal: null, names: { source: sourcePath, target: targetPath } });

test("ssh live series", { skip }, async (t) => {
    const harness = require("./helpers/engineHarness");
    const engine = await harness.start(ENGINE);
    t.after(() => engine.stop());
    const controlPlane = require("../../controlPlane/ControlPlaneServer");
    const sshSession = require("../sshSession");
    const sshTransfer = require("../tools/sshTransfer");
    const probe = (h, p) => sshSession.probeHostKey(target(h, p), params.username);

    await t.test("the probe reports the fingerprint ssh-keyscan computes for the negotiated algorithm", async () => {
        const key = await probe(host, port);
        assert.ok(KEYSCAN_TYPE[key.algorithm], `unexpected algorithm ${key.algorithm}`);
        assert.strictEqual(key.fingerprint, keyscan(host, port, key.algorithm));
    });

    await t.test("with the probed key a command runs", async () => {
        const { fingerprint } = await probe(host, port);
        const { client, close } = await sshSession.openTargetSession(target(host, port), params, { expectedHostKey: fingerprint, execOnly: true });
        try {
            const res = await client.exec("echo vault-ok", 10000);
            assert.strictEqual(res.stdout.trim(), "vault-ok");
            assert.strictEqual(res.exitCode, 0);
        } finally { close(); }
    });

    await t.test("with a wrong expected key the engine stops before any login attempt", async () => {
        const { fingerprint } = await probe(host, port);
        const marker = engine.sshdLogLines(TARGET).length;
        await assert.rejects(
            sshSession.openTargetSession(target(host, port), params, { expectedHostKey: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", execOnly: true }),
            (err) => err.code === "vault.host_key_changed" && err.details.actual === fingerprint,
        );
        const after = engine.sshdLogLines(TARGET).slice(marker).join("\n");
        assert.doesNotMatch(after, /Accepted|Failed password|Failed publickey|authentication failure/);
    });

    await t.test("a 5 MB file arrives byte for byte with the source's mode, a second time with overwrite with the replaced file's mode", async () => {
        const { fingerprint } = await probe(host, port);
        const open = () => sshSession.openTargetSession(target(host, port), params, { expectedHostKey: fingerprint });
        const from = await open();
        const to = await open();
        const home = (await to.client.realpath(".")).path.replace(/\/+$/, "");
        const sourcePath = `${home}/live-source.bin`;
        const targetPath = `${home}/live-upload.bin`;
        const modeOf = async (path) => (await to.client.stat(path, { owner: false })).mode & 0o777;
        try {
            const first = crypto.randomBytes(5 * 1024 * 1024);
            await from.client.writeFile(sourcePath, first);
            await from.client.chmod(sourcePath, 0o640);
            const source = await from.client.stat(sourcePath, { owner: false });
            assert.deepStrictEqual(await putThroughOutpost(sshTransfer, { from: from.client, to: to.client, sourcePath, targetPath, mode: source.mode }),
                { bytes: first.length, modeSet: true });
            assert.strictEqual(await sha256Of(to.client, targetPath), crypto.createHash("sha256").update(first).digest("hex"));
            assert.strictEqual(await modeOf(targetPath), 0o640);

            const second = crypto.randomBytes(5 * 1024 * 1024);
            await from.client.writeFile(sourcePath, second);
            await to.client.chmod(targetPath, 0o600);
            await putThroughOutpost(sshTransfer, { from: from.client, to: to.client, sourcePath, targetPath, mode: source.mode, overwrite: true });
            assert.strictEqual(await sha256Of(to.client, targetPath), crypto.createHash("sha256").update(second).digest("hex"));
            assert.strictEqual(await modeOf(targetPath), 0o600);
        } finally {
            await to.client.unlink(targetPath).catch(() => {});
            await from.client.unlink(sourcePath).catch(() => {});
            from.close();
            to.close();
        }
    });

    await t.test("an exclusive write creates the file with 0600 and refuses an existing path", async () => {
        const { fingerprint } = await probe(host, port);
        const session = await sshSession.openTargetSession(target(host, port), params, { expectedHostKey: fingerprint });
        const home = (await session.client.realpath(".")).path.replace(/\/+$/, "");
        const path = `${home}/live-excl.tmp`;
        try {
            await session.client.writeFile(path, Buffer.from("x"), { exclusive: true });
            assert.strictEqual((await session.client.stat(path, { owner: false })).mode & 0o777, 0o600);
            await assert.rejects(session.client.writeFile(path, Buffer.from("y"), { exclusive: true }), /Already exists|Operation failed/);
        } finally {
            await session.client.unlink(path).catch(() => {});
            session.close();
        }
    });

    await t.test("a target without an sftp subsystem runs commands but refuses files", { skip: NOSFTP ? false : "set OUTPOST_SSH_E2E_NOSFTP" }, async () => {
        const [nh, np] = NOSFTP.split(":");
        const { fingerprint } = await probe(nh, np);
        const { client, close } = await sshSession.openTargetSession(target(nh, np), params, { expectedHostKey: fingerprint, execOnly: true });
        try {
            assert.strictEqual((await client.exec("echo no-sftp-ok", 10000)).stdout.trim(), "no-sftp-ok");
        } finally { close(); }
        await assert.rejects(
            sshSession.openTargetSession(target(nh, np), params, { expectedHostKey: fingerprint }),
            (err) => err.code === "vault.ssh_failed" && /SFTP not available/.test(err.message),
        );
    });

    await t.test("closing the session during a running command ends it in the engine within 2 s", async () => {
        const { fingerprint } = await probe(host, port);
        let sessionId = null;
        const openSession = controlPlane.openSession;
        controlPlane.openSession = function (id, ...rest) { sessionId = id; return openSession.call(this, id, ...rest); };
        let session;
        try {
            session = await sshSession.openTargetSession(target(host, port), params, { expectedHostKey: fingerprint, execOnly: true });
        } finally { controlPlane.openSession = openSession; }
        const closed = new Promise((resolve) => {
            const onClosed = (event) => {
                if (event.sessionId !== sessionId) return;
                controlPlane.off("sessionClosed", onClosed);
                resolve(event);
            };
            controlPlane.on("sessionClosed", onClosed);
        });
        const run = session.client.exec("sleep 30", 60000).catch(() => null);
        await delay(1000);
        session.close();
        const event = await Promise.race([closed, delay(2000).then(() => null)]);
        assert.ok(event, "no sessionClosed within 2 s");
        assert.strictEqual(event.reason, "session ended");
        await run;
    });
});

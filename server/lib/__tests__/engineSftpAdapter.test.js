const test = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const { createEngineSftpAdapter } = require("../fileTransfer/engineSftpAdapter");

const fakeClient = (overrides = {}) => ({
    listDir: async () => [
        { name: "a.txt", type: "file", isSymlink: false, last_modified: 1700000000, size: 12, mode: 33188 },
    ],
    stat: async () => ({ size: 42, isDir: true, mtime: 1700000001 }),
    readFile: () => ({ stream: new PassThrough(), totalSizePromise: Promise.resolve(0), done: Promise.resolve() }),
    writeFile: async () => undefined,
    mkdirRecursive: async () => [],
    unlink: async () => undefined,
    rmdir: async () => undefined,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    ...overrides,
});

test("listDir renames last_modified and keeps mode", async () => {
    const adapter = createEngineSftpAdapter(fakeClient(), { shell: true });
    assert.deepStrictEqual(await adapter.listDir("/srv"), [
        { name: "a.txt", type: "file", size: 12, mtime: 1700000000, isSymlink: false, mode: 33188 },
    ]);
});

test("stat converts isDir into a type and reserves isSymlink", async () => {
    const adapter = createEngineSftpAdapter(fakeClient(), { shell: true });
    assert.deepStrictEqual(await adapter.stat("/srv"),
        { size: 42, type: "folder", mtime: 1700000001, isSymlink: false });
});

test("stat reports files as type file", async () => {
    const client = fakeClient({ stat: async () => ({ size: 7, isDir: false, mtime: 5 }) });
    const adapter = createEngineSftpAdapter(client, { shell: true });
    assert.strictEqual((await adapter.stat("/srv/a.txt")).type, "file");
});

test("readFile drops totalSizePromise", () => {
    const adapter = createEngineSftpAdapter(fakeClient(), { shell: true });
    assert.deepStrictEqual(Object.keys(adapter.readFile("/srv/a.txt")).sort(), ["done", "stream"]);
});

// FileTransfer can only refuse a source and a destination that share one connection if the adapter
// says which connection it is on. Without this the pairing deadlocks in a request timeout.
test("the adapter names the client it works on", () => {
    const client = fakeClient();
    assert.strictEqual(createEngineSftpAdapter(client, { shell: true }).transport, client);
});

// The transfer runs on its own per-transfer client, so it is the one caller allowed to pause the
// socket — and the only one that gets end-to-end backpressure out of it.
test("readFile asks the client for backpressure", () => {
    const calls = [];
    const client = fakeClient({
        readFile: (path, options) => {
            calls.push({ path, options });
            return { stream: new PassThrough(), totalSizePromise: Promise.resolve(0), done: Promise.resolve() };
        },
    });
    createEngineSftpAdapter(client, { shell: true }).readFile("/srv/a.txt");
    assert.deepStrictEqual(calls, [{ path: "/srv/a.txt", options: { backpressure: true } }]);
});

test("checksum runs the algorithm command and returns only the hash", async () => {
    const calls = [];
    const client = fakeClient({
        exec: async (cmd) => {
            calls.push(cmd);
            return { stdout: "d41d8cd98f00b204e9800998ecf8427e  /srv/a.txt\n", stderr: "", exitCode: 0 };
        },
    });
    const adapter = createEngineSftpAdapter(client, { shell: true });
    assert.strictEqual(await adapter.checksum("/srv/a.txt", "md5"), "d41d8cd98f00b204e9800998ecf8427e");
    assert.match(calls[0], /^md5sum /);
});

test("checksum normalises the algorithm name", async () => {
    const client = fakeClient({
        exec: async () => ({ stdout: "a".repeat(64) + "  /srv/a.txt\n", stderr: "", exitCode: 0 }),
    });
    const adapter = createEngineSftpAdapter(client, { shell: true });
    assert.strictEqual((await adapter.checksum("/srv/a.txt", "SHA256")).length, 64);
});

// A non-zero exit code must never pass: _verifyAll deletes the source behind this gate.
test("a non-zero exit code rejects instead of returning garbage as a hash", async () => {
    const client = fakeClient({
        exec: async () => ({ stdout: "usage: md5sum", stderr: "not found", exitCode: 127 }),
    });
    const adapter = createEngineSftpAdapter(client, { shell: true });
    await assert.rejects(() => adapter.checksum("/srv/a.txt", "md5"), /not found/);
});

test("output that is not a hash rejects", async () => {
    const client = fakeClient({ exec: async () => ({ stdout: "banner text\n", stderr: "", exitCode: 0 }) });
    const adapter = createEngineSftpAdapter(client, { shell: true });
    await assert.rejects(() => adapter.checksum("/srv/a.txt", "md5"), /usable hash/);
});

test("checksum is unavailable without a shell", async () => {
    const adapter = createEngineSftpAdapter(fakeClient(), { shell: false });
    assert.strictEqual(adapter.supportsChecksum, false);
    await assert.rejects(() => adapter.checksum("/srv/a.txt", "md5"), /does not support checksums/);
});

test("checksum rejects an unknown algorithm", async () => {
    const adapter = createEngineSftpAdapter(fakeClient(), { shell: true });
    await assert.rejects(() => adapter.checksum("/srv/a.txt", "crc32"), /unsupported algorithm/i);
});

const test = require("node:test");
const assert = require("node:assert");
const { resolveOpeningDirectory } = require("../parentChain");

// `probe` stands in for a listDir over the wire: it answers true for readable directories.
const probeOver = (readable) => async (path) => readable.includes(path);

test("a resumed session keeps its own path without probing anything", async () => {
    let probed = 0;
    const result = await resolveOpeningDirectory({
        storedSessionPath: "/volume1/docker",
        storedRow: "/etc",
        probe: async () => { probed++; return true; },
        homePath: "/root",
    });
    assert.deepStrictEqual(result, { path: "/volume1/docker", restoredFrom: null });
    assert.strictEqual(probed, 0);
});

test("the remembered row is used when it still holds", async () => {
    const result = await resolveOpeningDirectory({
        storedSessionPath: null,
        storedRow: "/volume1/docker",
        probe: probeOver(["/volume1/docker"]),
        homePath: "/root",
    });
    assert.deepStrictEqual(result, { path: "/volume1/docker", restoredFrom: null });
});

test("a dead remembered path climbs to the nearest surviving ancestor and reports it", async () => {
    const result = await resolveOpeningDirectory({
        storedSessionPath: null,
        storedRow: "/volume1/docker/alt",
        probe: probeOver(["/volume1/docker", "/volume1", "/"]),
        homePath: "/root",
    });
    assert.deepStrictEqual(result, { path: "/volume1/docker", restoredFrom: "/volume1/docker/alt" });
});

test("an existing but unreadable directory climbs too - stat would not have caught it", async () => {
    const result = await resolveOpeningDirectory({
        storedSessionPath: null,
        storedRow: "/home/other",
        probe: probeOver(["/home", "/"]),
        homePath: "/root",
    });
    assert.deepStrictEqual(result, { path: "/home", restoredFrom: "/home/other" });
});

test("with no remembered row the home directory is used - and probed", async () => {
    const seen = [];
    const result = await resolveOpeningDirectory({
        storedSessionPath: null,
        storedRow: null,
        probe: async (p) => { seen.push(p); return p === "/root"; },
        homePath: "/root",
    });
    assert.deepStrictEqual(result, { path: "/root", restoredFrom: null });
    assert.deepStrictEqual(seen, ["/root"]);
});

test("when nothing holds, the root is returned unprobed", async () => {
    const result = await resolveOpeningDirectory({
        storedSessionPath: null,
        storedRow: "/gone",
        probe: async () => false,
        homePath: "/root",
    });
    assert.deepStrictEqual(result, { path: "/", restoredFrom: "/gone" });
});

test("a probe that throws counts as not readable, never as a crash", async () => {
    const result = await resolveOpeningDirectory({
        storedSessionPath: null,
        storedRow: "/volume1/docker/alt",
        probe: async (p) => { if (p !== "/volume1") throw new Error("permission denied"); return true; },
        homePath: "/root",
    });
    assert.deepStrictEqual(result, { path: "/volume1", restoredFrom: "/volume1/docker/alt" });
});

test("the climb stops at the probe budget instead of walking 32 levels", async () => {
    const deep = "/" + Array.from({ length: 20 }, (_, i) => `d${i}`).join("/");
    let probed = 0;
    await resolveOpeningDirectory({
        storedSessionPath: null, storedRow: deep,
        probe: async () => { probed++; return false; }, homePath: "/root",
    });
    // 1 for the remembered path, MAX_PROBES for the climb, 1 for the home directory.
    assert.ok(probed <= 8, `probed ${probed} times - the budget is not holding`);
});

test("a closed connection stops the climb instead of probing the rest of the tree", async () => {
    let probed = 0;
    const result = await resolveOpeningDirectory({
        storedSessionPath: null, storedRow: "/a/b/c/d",
        probe: async () => { probed++; throw new Error("Connection closed"); }, homePath: "/root",
    });
    assert.strictEqual(probed, 1);
    assert.strictEqual(result.path, "/");
    assert.strictEqual(result.aborted, true);
});

test("a request timeout stops the climb too - it is what a closed client answers with", async () => {
    let probed = 0;
    const result = await resolveOpeningDirectory({
        storedSessionPath: null, storedRow: "/a/b/c/d",
        probe: async () => { probed++; throw new Error("Request timeout"); }, homePath: "/root",
    });
    assert.strictEqual(probed, 1);
    assert.strictEqual(result.aborted, true);
});

test("a chain longer than the budget still ends at the root", async () => {
    const deep = "/" + Array.from({ length: 12 }, (_, i) => `d${i}`).join("/");
    const seen = [];
    await resolveOpeningDirectory({
        storedSessionPath: null, storedRow: deep,
        probe: async (p) => { seen.push(p); return false; }, homePath: "/root",
    });
    assert.ok(seen.includes("/"), "the root fell out of the budgeted chain");
});

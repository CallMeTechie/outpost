const test = require("node:test");
const assert = require("node:assert");
const { openPaneDirectory } = require("../../routes/sftpWS");

// openingDirectory.test.js covers every branch of the climb, but it injects `homePath` as a
// ready-made string. openPaneDirectory is the only place that value is actually produced, so it is
// the only place its type can be wrong - and it was: EngineSftpClient.realpath resolves
// { path, isDirectory } (RealpathResult in EngineSftpClient.js), not a string. These tests drive
// the seam with that real shape.

// Stands in for EngineSftpClient: realpath answers the way the RealpathResult handler does, and
// listDir records every argument it is handed - including the ones that are not strings.
const fakeClient = ({ realpathResult, readable = [] }) => {
    const listed = [];
    return {
        listed,
        realpath: async () => realpathResult,
        listDir: async (path) => {
            listed.push(path);
            if (typeof path !== "string") throw new Error("no such file");
            if (!readable.includes(path)) throw new Error("no such file");
            return [];
        },
    };
};

test("the home directory is probed as the string realpath resolved, never as the result object", async () => {
    const client = fakeClient({
        realpathResult: { path: "/root", isDirectory: true },
        readable: ["/root"],
    });

    const opening = await openPaneDirectory({
        sftpClient: client,
        storedSessionPath: null,
        storedRow: null,
    });

    assert.deepStrictEqual(client.listed, ["/root"], "the probe did not receive the plain home path");
    for (const path of client.listed) {
        assert.strictEqual(typeof path, "string", `listDir was called with a ${typeof path}, not a string`);
    }
    assert.deepStrictEqual(opening, { path: "/root", restoredFrom: null });
});

test("the climb's last fallback is the home directory, and it is probed as a string too", async () => {
    // Nothing along /gone/deeper holds, so the chain falls through to the home directory - the one
    // branch that only ever runs once the climb has failed.
    const client = fakeClient({
        realpathResult: { path: "/home/ma", isDirectory: true },
        readable: ["/home/ma"],
    });

    const opening = await openPaneDirectory({
        sftpClient: client,
        storedSessionPath: null,
        storedRow: "/gone/deeper",
    });

    assert.ok(client.listed.includes("/home/ma"), "the home directory was never probed as a string");
    assert.deepStrictEqual(opening, { path: "/home/ma", restoredFrom: "/gone/deeper" });
});

test("a realpath that answers with nothing usable leaves the pane at the root, not at a bad probe", async () => {
    // The engine answers an empty RealpathResult with {} - no path at all. That must become null,
    // not undefined handed on to listDir.
    const client = fakeClient({ realpathResult: {}, readable: ["/root"] });

    const opening = await openPaneDirectory({
        sftpClient: client,
        storedSessionPath: null,
        storedRow: null,
    });

    assert.deepStrictEqual(client.listed, [], "an unknown home directory was probed anyway");
    assert.deepStrictEqual(opening, { path: "/", restoredFrom: null });
});

test("a failing realpath is not a failing connection - the pane still opens", async () => {
    const client = fakeClient({ realpathResult: null, readable: [] });
    client.realpath = async () => { throw new Error("permission denied"); };

    const opening = await openPaneDirectory({
        sftpClient: client,
        storedSessionPath: null,
        storedRow: null,
    });

    assert.deepStrictEqual(opening, { path: "/", restoredFrom: null });
});

test("a resumed session never asks the client for anything", async () => {
    const client = fakeClient({ realpathResult: { path: "/root", isDirectory: true } });
    let realpathCalls = 0;
    client.realpath = async () => { realpathCalls++; return { path: "/root", isDirectory: true }; };

    const opening = await openPaneDirectory({
        sftpClient: client,
        storedSessionPath: "/volume1/docker",
        storedRow: null,
    });

    // realpath still runs - it is asked for before the chain decides - but nothing is ever probed.
    assert.strictEqual(realpathCalls, 1);
    assert.deepStrictEqual(client.listed, []);
    assert.deepStrictEqual(opening, { path: "/volume1/docker", restoredFrom: null });
});

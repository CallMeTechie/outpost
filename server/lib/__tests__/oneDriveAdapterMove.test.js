const test = require("node:test");
const assert = require("node:assert");
const { createOneDriveAdapter } = require("../microsoft/oneDriveAdapter");

const adapterOn = (handler) => {
    const calls = [];
    const graph = { calls, request: async (connectionId, options) => { calls.push(options); return handler(options, calls.length); } };
    return { graph, calls, adapter: createOneDriveAdapter({ graph, connectionId: 1 }) };
};

// Microsoft moves an item itself: one PATCH of its parent, and not a byte through Outpost.
test("moving an item patches its parent reference", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));

    await adapter.move("/a/brief.txt", "/b");

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "PATCH");
    assert.strictEqual(calls[0].url, "/root:/a/brief.txt:");
    assert.deepStrictEqual(JSON.parse(calls[0].body).parentReference, { path: "/drive/root:/b" });
});

test("moving into the drive root addresses the root, not an empty path", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));

    await adapter.move("/a/brief.txt", "/");

    assert.deepStrictEqual(JSON.parse(calls[0].body).parentReference, { path: "/drive/root:" });
});

test("copying asks Graph to copy and waits for it to finish", async () => {
    const { calls, adapter } = adapterOn((options, n) => {
        if (n === 1) return { status: 202, headers: new Map([["location", "https://graph.example/monitor/1"]]), body: null };
        return { body: { status: "completed" } };
    });

    await adapter.copy("/a/brief.txt", "/b");

    assert.strictEqual(calls[0].method, "POST");
    assert.match(calls[0].url, /\/copy$/);
    assert.strictEqual(calls[1].url, "https://graph.example/monitor/1");
    assert.strictEqual(calls[1].anonymous, true, "the monitor url is pre-authenticated like an upload session");
});

test("a copy that Microsoft reports as failed is reported as failed", async () => {
    const { adapter } = adapterOn((options, n) => {
        if (n === 1) return { status: 202, headers: new Map([["location", "https://graph.example/monitor/1"]]), body: null };
        return { body: { status: "failed", error: { message: "no room" } } };
    });

    await assert.rejects(adapter.copy("/a.txt", "/b"), /copy/i);
});

test("a copy without a monitor url fails rather than reporting success it cannot see", async () => {
    const { adapter } = adapterOn(() => ({ status: 202, headers: new Map(), body: null }));

    await assert.rejects(adapter.copy("/a.txt", "/b"), /monitor/i);
});

// Polling must not run forever if Microsoft never finishes.
test("a copy that never completes gives up instead of polling forever", async () => {
    let polls = 0;
    const { adapter } = adapterOn((options, n) => {
        if (n === 1) return { status: 202, headers: new Map([["location", "https://graph.example/monitor/1"]]), body: null };
        polls += 1;
        return { body: { status: "inProgress" } };
    });

    await assert.rejects(adapter.copy("/a.txt", "/b", { pollDelayMs: 0 }), /did not finish/i);
    assert.ok(polls <= 60, `polled ${polls} times`);
});

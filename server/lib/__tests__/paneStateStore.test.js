const test = require("node:test");
const assert = require("node:assert");
const { createPaneStateWriter, MAX_REMEMBERED_PATH } = require("../paneStateStore");

const key = { accountId: 1, entryId: 7, identityId: 0 };

test("several navigations within the window collapse into one write", async () => {
    const writes = [];
    const writer = createPaneStateWriter({ upsert: async (...a) => { writes.push(a); }, delayMs: 5 });
    writer.schedule(key, "/volume1");
    writer.schedule(key, "/volume1/docker");
    writer.schedule(key, "/volume1/docker/nexterm");
    await writer.flush();
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0][1], "/volume1/docker/nexterm");
});

test("flush writes the pending path immediately - closing the tab must not lose the last step", async () => {
    const writes = [];
    const writer = createPaneStateWriter({ upsert: async (...a) => { writes.push(a); }, delayMs: 100000 });
    writer.schedule(key, "/volume1/docker");
    await writer.flush();
    assert.deepStrictEqual(writes[0][1], "/volume1/docker");
});

test("flush with nothing pending writes nothing", async () => {
    const writes = [];
    const writer = createPaneStateWriter({ upsert: async (...a) => { writes.push(a); }, delayMs: 5 });
    await writer.flush();
    assert.strictEqual(writes.length, 0);
});

test("the path is normalized before it is written", async () => {
    const writes = [];
    const writer = createPaneStateWriter({ upsert: async (...a) => { writes.push(a); }, delayMs: 5 });
    writer.schedule(key, "/volume1//docker/");
    await writer.flush();
    assert.strictEqual(writes[0][1], "/volume1/docker");
});

test("a path longer than the column is skipped silently, not written and not thrown", async () => {
    // MySQL in strict mode would reject it while SQLite would store it whole - the same navigation
    // behaving differently per dialect is worse than not remembering that one directory.
    const writes = [];
    const writer = createPaneStateWriter({ upsert: async (...a) => { writes.push(a); }, delayMs: 5 });
    writer.schedule(key, "/" + "x".repeat(MAX_REMEMBERED_PATH + 1));
    await writer.flush();
    assert.strictEqual(writes.length, 0);
});

test("a failing write is caught and reported, never left as an unhandled rejection", async () => {
    const errors = [];
    const writer = createPaneStateWriter({
        upsert: async () => { throw new Error("database is locked"); },
        delayMs: 5,
        onError: (e) => errors.push(e),
    });
    writer.schedule(key, "/volume1/docker");
    await writer.flush();
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].message, /database is locked/);
});

test("scheduling without an entryId writes nothing - a direct connection has no key", async () => {
    const writes = [];
    const writer = createPaneStateWriter({ upsert: async (...a) => { writes.push(a); }, delayMs: 5 });
    writer.schedule({ accountId: 1, entryId: null, identityId: 0 }, "/volume1");
    await writer.flush();
    assert.strictEqual(writes.length, 0);
});

test("scheduling after a flush is ignored - the socket is gone, the write has no owner", async () => {
    const writes = [];
    const writer = createPaneStateWriter({ upsert: async (...a) => { writes.push(a); }, delayMs: 5 });
    await writer.flush();
    writer.schedule(key, "/volume1/late");
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(writes.length, 0);
});

test("two writes on the same key never overlap - they run in order", async () => {
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const writer = createPaneStateWriter({
        upsert: async (_k, p) => { order.push(`start:${p}`); if (p === "/a") await gate; order.push(`end:${p}`); },
        delayMs: 1,
    });
    writer.schedule(key, "/a");
    await new Promise((r) => setTimeout(r, 5));
    writer.schedule(key, "/b");
    await new Promise((r) => setTimeout(r, 5));
    release();
    await writer.flush();
    assert.deepStrictEqual(order, ["start:/a", "end:/a", "start:/b", "end:/b"]);
});

test("flush waits for a write the timer already started", async () => {
    const done = [];
    const writer = createPaneStateWriter({
        upsert: async () => { await new Promise((r) => setTimeout(r, 20)); done.push(1); },
        delayMs: 1,
    });
    writer.schedule(key, "/volume1/docker");
    await new Promise((r) => setTimeout(r, 5));
    await writer.flush();
    assert.strictEqual(done.length, 1, "flush returned while the write was still in flight");
});

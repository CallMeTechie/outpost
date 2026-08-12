const test = require("node:test");
const assert = require("node:assert");
const { uploadLarge, CHUNK_SIZE, SIMPLE_UPLOAD_LIMIT } = require("../microsoft/oneDriveUpload");

const SESSION_URL = "https://upload.example/session/1";

// An async generator is pulled exactly one piece per iteration, so how often it was pulled is a
// direct measurement of what the uploader read — which is what the backpressure test needs.
const source = (total, piece, onPull = () => {}) => (async function* () {
    let sent = 0;
    while (sent < total) {
        const size = Math.min(piece, total - sent);
        sent += size;
        onPull(sent);
        yield Buffer.alloc(size, 7);
    }
})();

const fakeGraph = ({ onPut = () => ({ status: 202, body: {} }), sessionBody = { uploadUrl: SESSION_URL } } = {}) => {
    const calls = { puts: [], deletes: [], sessions: 0 };
    return {
        calls,
        request: async (connectionId, options) => {
            if (options.method === "POST") { calls.sessions += 1; return { status: 200, body: sessionBody }; }
            if (options.method === "DELETE") { calls.deletes.push(options.url); return { status: 204, body: null }; }
            calls.puts.push({ url: options.url, range: options.headers["Content-Range"], length: options.body.length });
            return onPut(calls.puts.length);
        },
    };
};

test("the chunk size is a multiple of Microsoft's 320 KiB unit", () => {
    assert.strictEqual(CHUNK_SIZE % (320 * 1024), 0);
    assert.strictEqual(CHUNK_SIZE, 5 * 1024 * 1024);
    assert.strictEqual(SIMPLE_UPLOAD_LIMIT, 4 * 1024 * 1024);
});

test("a file of two and a half chunks goes up in three pieces with exact ranges", async () => {
    const total = CHUNK_SIZE * 2 + 1024;
    const graph = fakeGraph();

    await uploadLarge({ graph, connectionId: 1, itemPath: "/root:/big.bin:", source: source(total, 65536), size: total });

    assert.strictEqual(graph.calls.puts.length, 3);
    assert.strictEqual(graph.calls.puts[0].range, `bytes 0-${CHUNK_SIZE - 1}/${total}`);
    assert.strictEqual(graph.calls.puts[1].range, `bytes ${CHUNK_SIZE}-${CHUNK_SIZE * 2 - 1}/${total}`);
    assert.strictEqual(graph.calls.puts[2].range, `bytes ${CHUNK_SIZE * 2}-${total - 1}/${total}`);
    assert.strictEqual(graph.calls.puts[2].length, 1024);
});

test("a file of exactly one chunk goes up in one piece", async () => {
    const graph = fakeGraph();

    await uploadLarge({ graph, connectionId: 1, itemPath: "/root:/x:", source: source(CHUNK_SIZE, CHUNK_SIZE), size: CHUNK_SIZE });

    assert.strictEqual(graph.calls.puts.length, 1);
});

test("every chunk goes to the session url, not to the item", async () => {
    const graph = fakeGraph();

    await uploadLarge({ graph, connectionId: 1, itemPath: "/root:/x:", source: source(CHUNK_SIZE + 5, 4096), size: CHUNK_SIZE + 5 });

    for (const put of graph.calls.puts) assert.strictEqual(put.url, SESSION_URL);
});

// The heart of Global Constraint 4: while a PUT is pending — including any throttling backoff
// inside it — nothing may be read from the source, or FileTransfer's 8 MiB buffer overflows and
// aborts the transfer with "Destination too slow" before the backoff ever helped.
test("nothing is read from the source while a chunk is in flight", async () => {
    const total = CHUNK_SIZE * 3;
    const piece = 64 * 1024;
    let pulled = 0;
    let pulledWhenGated = null;

    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const graph = fakeGraph({
        onPut: (n) => {
            if (n !== 1) return { status: 202, body: {} };
            pulledWhenGated = pulled;
            return gate.then(() => ({ status: 202, body: {} }));
        },
    });

    const running = uploadLarge({
        graph, connectionId: 1, itemPath: "/root:/x:", size: total,
        source: source(total, piece, (sent) => { pulled = sent; }),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(pulled, pulledWhenGated,
        "the source was read further while the first chunk was still being sent");
    assert.ok(pulled <= CHUNK_SIZE + piece, `read ${pulled} bytes ahead of a single chunk`);

    release();
    await running;
});

test("no bearer token is sent to the pre-authenticated session url", async () => {
    const seen = [];
    const graph = fakeGraph();
    const inner = graph.request;
    graph.request = async (connectionId, options) => { seen.push(options); return inner(connectionId, options); };

    await uploadLarge({ graph, connectionId: 1, itemPath: "/root:/x:", source: source(CHUNK_SIZE + 5, 4096), size: CHUNK_SIZE + 5 });

    const session = seen.find((o) => o.method === "POST");
    assert.notStrictEqual(session.anonymous, true, "opening the session is a normal Graph call");
    for (const put of seen.filter((o) => o.method === "PUT")) {
        assert.strictEqual(put.anonymous, true, "a chunk must not carry the token");
    }
});

test("a size that does not match what the source delivered is refused", async () => {
    const graph = fakeGraph();

    await assert.rejects(
        uploadLarge({ graph, connectionId: 1, itemPath: "/root:/x:", source: source(CHUNK_SIZE + 10, 4096), size: CHUNK_SIZE + 99 }),
        /expected/i);
});

test("a failed chunk discards the session instead of leaving it behind", async () => {
    const graph = fakeGraph({ onPut: () => { throw new Error("Microsoft said no"); } });

    await assert.rejects(uploadLarge({
        graph, connectionId: 1, itemPath: "/root:/x:", source: source(CHUNK_SIZE + 1, 4096), size: CHUNK_SIZE + 1,
    }));

    assert.deepStrictEqual(graph.calls.deletes, [SESSION_URL]);
});

test("discarding the session never replaces the original error", async () => {
    const graph = fakeGraph({ onPut: () => { throw new Error("the real reason"); } });
    graph.request = new Proxy(graph.request, {
        apply(target, thisArg, args) {
            if (args[1].method === "DELETE") throw new Error("cleanup also failed");
            return Reflect.apply(target, thisArg, args);
        },
    });

    await assert.rejects(uploadLarge({
        graph, connectionId: 1, itemPath: "/root:/x:", source: source(CHUNK_SIZE + 1, 4096), size: CHUNK_SIZE + 1,
    }), /the real reason/);
});

// Writing the next chunk at the wrong offset corrupts the file in a way the size check at the end
// would not catch: the length is right, the content is shifted.
test("a range Microsoft does not expect stops the upload", async () => {
    const graph = fakeGraph({
        onPut: (n) => (n === 1
            ? { status: 202, body: { nextExpectedRanges: ["999999-"] } }
            : { status: 202, body: {} }),
    });

    await assert.rejects(uploadLarge({
        graph, connectionId: 1, itemPath: "/root:/x:", source: source(CHUNK_SIZE * 2, 65536), size: CHUNK_SIZE * 2,
    }), /expected the next chunk/i);
});

test("a session without an upload url fails before anything is read", async () => {
    const graph = fakeGraph({ sessionBody: {} });

    await assert.rejects(uploadLarge({
        graph, connectionId: 1, itemPath: "/root:/x:", source: source(CHUNK_SIZE + 1, 4096), size: CHUNK_SIZE + 1,
    }), /upload session/i);

    assert.strictEqual(graph.calls.puts.length, 0);
});

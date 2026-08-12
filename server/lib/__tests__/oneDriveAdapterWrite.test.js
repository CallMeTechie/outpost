const test = require("node:test");
const assert = require("node:assert");
const { PassThrough, Readable } = require("node:stream");
const { createOneDriveAdapter } = require("../microsoft/oneDriveAdapter");
const { SIMPLE_UPLOAD_LIMIT, CHUNK_SIZE } = require("../microsoft/oneDriveUpload");

const graphError = (status, code = null) => {
    const error = new Error(`status ${status}`);
    error.name = "GraphError";
    error.status = status;
    error.code = code;
    return error;
};

const adapterOn = (handler) => {
    const calls = [];
    const graph = { calls, request: async (connectionId, options) => { calls.push(options); return handler(options, calls.length); } };
    return { graph, calls, adapter: createOneDriveAdapter({ graph, connectionId: 1 }) };
};

const streamOf = (buffer) => Readable.from([buffer]);

test("a small file goes up as one PUT to the item's content", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));
    const payload = Buffer.alloc(1024, 3);

    await adapter.writeFile("/klein.bin", streamOf(payload), { size: payload.length });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "/root:/klein.bin:/content");
    assert.strictEqual(calls[0].method, "PUT");
    assert.ok(calls[0].body.equals(payload));
});

test("a file exactly at the simple limit still goes up as one PUT", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));
    const payload = Buffer.alloc(SIMPLE_UPLOAD_LIMIT, 1);

    await adapter.writeFile("/grenz.bin", streamOf(payload), { size: payload.length });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "PUT");
});

test("one byte past the limit opens an upload session", async () => {
    const size = SIMPLE_UPLOAD_LIMIT + 1;
    const { calls, adapter } = adapterOn((options) => (options.method === "POST"
        ? { body: { uploadUrl: "https://upload.example/s" } }
        : { status: 202, body: {} }));

    await adapter.writeFile("/gross.bin", streamOf(Buffer.alloc(size, 1)), { size });

    assert.strictEqual(calls[0].method, "POST");
    assert.match(calls[0].url, /createUploadSession$/);
});

test("a Buffer needs no size hint — it knows its own", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));

    await adapter.writeFile("/b.bin", Buffer.alloc(50, 9));

    assert.strictEqual(calls[0].body.length, 50);
});

// Graph demands the total length in every chunk's Content-Range. Without the hint the adapter
// would have to buffer the whole stream to find out, which is what the hint exists to avoid.
test("a stream without a size hint is refused, not buffered", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));

    await assert.rejects(adapter.writeFile("/x.bin", streamOf(Buffer.alloc(10))), /size/i);
    assert.strictEqual(calls.length, 0);
});

// A source that lies about its size must not be able to grow the buffer without bound.
test("a small upload that delivers more than promised is stopped", async () => {
    const { adapter } = adapterOn(() => ({ body: {} }));
    const lying = Readable.from([Buffer.alloc(SIMPLE_UPLOAD_LIMIT, 1), Buffer.alloc(4096, 1)]);

    await assert.rejects(adapter.writeFile("/lie.bin", lying, { size: 1024 }), /more/i);
});

test("a small upload that delivers fewer bytes than promised is stopped", async () => {
    const { adapter } = adapterOn(() => ({ body: {} }));

    await assert.rejects(adapter.writeFile("/kurz.bin", streamOf(Buffer.alloc(10)), { size: 4096 }), /delivered 10/);
});

// FileTransfer has no AbortSignal — it cancels by destroying the source stream.
test("destroying the source reaches the running upload and discards the session", async () => {
    const size = SIMPLE_UPLOAD_LIMIT + 1;
    const seen = [];
    let captured = null;

    const graph = {
        request: async (connectionId, options) => {
            seen.push(options);
            if (options.method === "POST") return { body: { uploadUrl: "https://upload.example/s" } };
            if (options.method === "DELETE") return { body: null };

            captured = options.signal;
            return new Promise((resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(new Error("aborted")));
            });
        },
    };

    const adapter = createOneDriveAdapter({ graph, connectionId: 1 });
    const source = new PassThrough();
    const running = adapter.writeFile("/gross.bin", source, { size });
    running.catch(() => {});

    source.write(Buffer.alloc(CHUNK_SIZE, 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.destroy(new Error("cancelled by the user"));

    await assert.rejects(running);
    assert.ok(captured?.aborted, "the chunk in flight must be told to stop");
    assert.ok(seen.some((o) => o.method === "DELETE"), "and the session must not be left behind");
});

test("mkdirRecursive creates every level in order", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));

    await adapter.mkdirRecursive("/a/b/c");

    assert.deepStrictEqual(calls.map((c) => c.url), ["/root/children", "/root:/a:/children", "/root:/a/b:/children"]);
    assert.deepStrictEqual(calls.map((c) => JSON.parse(c.body).name), ["a", "b", "c"]);
});

test("mkdirRecursive asks Graph to fail on a conflict rather than rename", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: {} }));

    await adapter.mkdirRecursive("/a");

    assert.strictEqual(JSON.parse(calls[0].body)["@microsoft.graph.conflictBehavior"], "fail");
});

// Several files under one parent make this the normal case, not the exception.
test("a level that already exists counts as created", async () => {
    const { adapter } = adapterOn(() => { throw graphError(409, "nameAlreadyExists"); });

    await adapter.mkdirRecursive("/a/b");
});

test("another conflict is not swallowed", async () => {
    const { adapter } = adapterOn(() => { throw graphError(409, "somethingElse"); });

    await assert.rejects(adapter.mkdirRecursive("/a"), /409/);
});

test("a failure that is not a conflict is not swallowed either", async () => {
    const { adapter } = adapterOn(() => { throw graphError(403); });

    await assert.rejects(adapter.mkdirRecursive("/a"), /403/);
});

test("unlink deletes the item", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: null }));

    await adapter.unlink("/a/b.txt");

    assert.strictEqual(calls[0].url, "/root:/a/b.txt:");
    assert.strictEqual(calls[0].method, "DELETE");
});

test("deleting something that is already gone is a success", async () => {
    const { adapter } = adapterOn(() => { throw graphError(404, "itemNotFound"); });

    await adapter.unlink("/weg.txt");
});

test("a delete that fails for another reason still fails", async () => {
    const { adapter } = adapterOn(() => { throw graphError(403); });

    await assert.rejects(adapter.unlink("/a.txt"), /403/);
});

// Graph deletes a folder with everything in it, always. The move cleanup path asks for the
// non-recursive form precisely to be told "not empty" — without the check, a move that skipped one
// file would delete that file along with the folder.
test("a non-recursive rmdir refuses a folder that still holds something", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: { value: [{ name: "rest.txt", file: {}, size: 1, lastModifiedDateTime: "2026-08-12T18:00:00Z" }] } }));

    await assert.rejects(adapter.rmdir("/ordner", false), /not empty/i);
    assert.ok(!calls.some((c) => c.method === "DELETE"), "nothing may be deleted");
});

test("a non-recursive rmdir deletes an empty folder", async () => {
    const { calls, adapter } = adapterOn((options) => (options.method === "DELETE" ? { body: null } : { body: { value: [] } }));

    await adapter.rmdir("/leer", false);

    assert.ok(calls.some((c) => c.method === "DELETE"));
});

test("a recursive rmdir does not bother looking first", async () => {
    const { calls, adapter } = adapterOn(() => ({ body: null }));

    await adapter.rmdir("/ordner", true);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "DELETE");
});

test("checksum refuses rather than pretending", async () => {
    const { adapter } = adapterOn(() => ({ body: {} }));

    await assert.rejects(adapter.checksum("/a.txt", "sha256"), /checksum/i);
});

test("the adapter offers exactly the seven mandatory methods plus checksum", () => {
    const { adapter } = adapterOn(() => ({ body: {} }));

    for (const name of ["listDir", "stat", "readFile", "writeFile", "mkdirRecursive", "unlink", "rmdir", "checksum"]) {
        assert.strictEqual(typeof adapter[name], "function", `${name} is missing`);
    }
});

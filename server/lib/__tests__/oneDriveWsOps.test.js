const test = require("node:test");
const assert = require("node:assert");
const { OP } = require("../../routes/sftpWS");
const { buildOneDriveHandlers, ONEDRIVE_OPS, resolveSocketConnection } = require("../../routes/oneDriveWS");

const harness = (adapter = {}) => {
    const sent = [];
    const handlers = buildOneDriveHandlers(OP, {
        adapter: {
            listDir: async () => [],
            stat: async () => ({ size: 1, type: "file", mtime: 0, isSymlink: false }),
            mkdirRecursive: async () => {},
            unlink: async () => {},
            rmdir: async () => {},
            ...adapter,
        },
        send: (op, data) => sent.push({ op, data }),
        connectionId: 7,
    });
    return { handlers, sent };
};

test("only the operations that mean something without a shell are offered", () => {
    const { handlers } = harness();

    for (const name of ["LIST_FILES", "STAT", "CREATE_FOLDER", "DELETE_FILE", "DELETE_FOLDER", "RENAME_FILE"]) {
        assert.strictEqual(typeof handlers[OP[name]], "function", `${name} is missing`);
    }
    for (const name of ["RESOLVE_SYMLINK", "CHMOD", "CHECKSUM", "PATH_SYNC", "SEARCH_DIRECTORIES", "FOLDER_SIZE"]) {
        assert.strictEqual(handlers[OP[name]], undefined, `${name} must not be offered on a drive without a shell`);
    }
});

test("listing a folder answers with its entries", async () => {
    const { handlers, sent } = harness({ listDir: async (path) => [{ name: `in ${path}`, type: "file", size: 3, mtime: 0, isSymlink: false }] });

    await handlers[OP.LIST_FILES]({ path: "/Dokumente" });

    assert.strictEqual(sent[0].op, OP.LIST_FILES);
    assert.strictEqual(sent[0].data.files[0].name, "in /Dokumente");
});

test("a listing without a path is refused rather than defaulted", async () => {
    const { handlers } = harness();

    for (const payload of [undefined, {}, { path: 42 }, { path: "" }]) {
        await assert.rejects(handlers[OP.LIST_FILES](payload), /path/i, `accepted ${JSON.stringify(payload)}`);
    }
});

test("creating a folder joins the parent and the name", async () => {
    const seen = [];
    const { handlers } = harness({ mkdirRecursive: async (path) => seen.push(path) });

    await handlers[OP.CREATE_FOLDER]({ path: "/Dokumente", name: "Neu" });

    assert.deepStrictEqual(seen, ["/Dokumente/Neu"]);
});

// A name is a single segment. A slash in it would silently create a tree the user did not ask for.
test("a folder name containing a separator is refused", async () => {
    const { handlers } = harness();

    for (const name of ["a/b", "/a", "..", ".", ""]) {
        await assert.rejects(handlers[OP.CREATE_FOLDER]({ path: "/", name }), /name/i, `accepted ${JSON.stringify(name)}`);
    }
});

test("deleting a file and deleting a folder use the right call", async () => {
    const calls = [];
    const { handlers } = harness({
        unlink: async (path) => calls.push(["unlink", path]),
        rmdir: async (path, recursive) => calls.push(["rmdir", path, recursive]),
    });

    await handlers[OP.DELETE_FILE]({ path: "/a.txt" });
    await handlers[OP.DELETE_FOLDER]({ path: "/Ordner" });

    assert.deepStrictEqual(calls, [["unlink", "/a.txt"], ["rmdir", "/Ordner", true]]);
});

test("renaming asks Graph to change the name and answers when it did", async () => {
    const seen = [];
    const { handlers, sent } = harness({ rename: async (path, name) => seen.push([path, name]) });

    await handlers[OP.RENAME_FILE]({ path: "/alt.txt", name: "neu.txt" });

    assert.deepStrictEqual(seen, [["/alt.txt", "neu.txt"]]);
    assert.strictEqual(sent[0].op, OP.RENAME_FILE);
});

test("ONEDRIVE_OPS names exactly the offered opcodes", () => {
    const { handlers } = harness();

    assert.deepStrictEqual([...ONEDRIVE_OPS].sort(), Object.keys(handlers).map(Number).sort());
});

// resolveSocketConnection returns { ok:false, code, reason } rather than a bare null, so the route
// (and this test) can tell a malformed id (4008 — a client bug) apart from a refused one (4403 —
// missing, foreign, disconnected or a database failure, all made to look identical on purpose).
test("a connection id is parsed as strictly as an endpoint descriptor", async () => {
    const owned = { id: 7, accountId: 5, status: "connected" };
    const deps = { loadConnection: async () => owned };

    assert.deepStrictEqual(await resolveSocketConnection("7", { id: 5 }, deps), { ok: true, connectionId: 7 });

    for (const raw of ["7abc", " 7 ", "07", "0", "-1", "+7", "7.0", "1e3", "", undefined, "0x7"]) {
        const result = await resolveSocketConnection(raw, { id: 5 }, deps);
        assert.strictEqual(result.ok, false, `accepted ${JSON.stringify(raw)}`);
        assert.strictEqual(result.code, 4008, `wrong close code for ${JSON.stringify(raw)}`);
    }
});

test("a foreign, missing or disconnected connection is refused alike", async () => {
    for (const connection of [null, { id: 7, accountId: 6, status: "connected" }, { id: 7, accountId: 5, status: "disconnected" }]) {
        const result = await resolveSocketConnection("7", { id: 5 }, { loadConnection: async () => connection });
        assert.deepStrictEqual(result, { ok: false, code: 4403, reason: "This Microsoft connection is not available" });
    }
});

test("a database failure is refused, not propagated", async () => {
    const deps = { loadConnection: async () => { throw new Error("SELECT * FROM microsoft_connections WHERE ..."); } };

    const result = await resolveSocketConnection("7", { id: 5 }, deps);

    assert.deepStrictEqual(result, { ok: false, code: 4403, reason: "This Microsoft connection is not available" });
});

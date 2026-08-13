const test = require("node:test");
const assert = require("node:assert");
const { OP } = require("../../routes/sftpWS");
const { buildOneDriveHandlers, ONEDRIVE_OPS, resolveSocketConnection, createSend } = require("../../routes/oneDriveWS");

const harness = (adapter = {}) => {
    const sent = [];
    const handlers = buildOneDriveHandlers(OP, {
        adapter: {
            listDir: async () => [],
            stat: async () => ({ size: 1, type: "file", mtime: 0, isSymlink: false }),
            mkdirRecursive: async () => {},
            unlink: async () => {},
            rmdir: async () => {},
            rename: async () => {},
            move: async () => {},
            copy: async () => {},
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

// The pane and the transfer seam read an entry differently, and the adapter speaks the transfer
// seam's shape. Every field FileItem.jsx and FileList.jsx read off an entry has to be here under
// the name they read it by — the date arrived as `mtime` and rendered as "Invalid Date".
test("a listing answers in the entry vocabulary the pane reads", async () => {
    const { handlers, sent } = harness({
        listDir: async () => [{ name: "a.txt", type: "file", size: 12, mtime: 1755000000, isSymlink: false }],
    });

    await handlers[OP.LIST_FILES]({ path: "/" });

    assert.deepStrictEqual(sent[0].data.files, [
        { name: "a.txt", type: "file", size: 12, isSymlink: false, last_modified: 1755000000 },
    ]);
});

test("a listing without a path is refused rather than defaulted", async () => {
    const { handlers } = harness();

    for (const payload of [undefined, {}, { path: 42 }, { path: "" }]) {
        await assert.rejects(handlers[OP.LIST_FILES](payload), /path/i, `accepted ${JSON.stringify(payload)}`);
    }
});

test("creating a folder takes the full path of the new folder", async () => {
    const seen = [];
    const { handlers } = harness({ mkdirRecursive: async (path) => seen.push(path) });

    await handlers[OP.CREATE_FOLDER]({ path: "/Dokumente/Neu" });

    assert.deepStrictEqual(seen, ["/Dokumente/Neu"]);
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

test("renaming derives the new name from the last segment of the target path", async () => {
    const seen = [];
    const { handlers, sent } = harness({ rename: async (path, name) => seen.push([path, name]) });

    await handlers[OP.RENAME_FILE]({ path: "/Dokumente/alt.txt", newPath: "/Dokumente/neu.txt" });

    assert.deepStrictEqual(seen, [["/Dokumente/alt.txt", "neu.txt"]]);
    assert.strictEqual(sent[0].op, OP.RENAME_FILE);
});

// A name is a single segment. Graph renames by name, so a target path whose last segment is empty,
// "." or ".." names nothing a rename could produce.
test("a target path without a usable last segment is refused", async () => {
    const { handlers } = harness({ rename: async () => { throw new Error("must not be called"); } });

    for (const newPath of ["/Dokumente/", "/Dokumente/.", "/Dokumente/..", "", 42, undefined]) {
        await assert.rejects(handlers[OP.RENAME_FILE]({ path: "/alt.txt", newPath }), /name|path/i,
            `accepted ${JSON.stringify(newPath)}`);
    }
});

test("moving and copying are offered and pass every source on", async () => {
    const moved = [];
    const copied = [];
    const { handlers } = harness({
        move: async (path, target) => moved.push([path, target]),
        copy: async (path, target) => copied.push([path, target]),
    });

    await handlers[OP.MOVE_FILES]({ sources: ["/a.txt", "/b.txt"], destination: "/Ziel" });
    await handlers[OP.COPY_FILES]({ sources: ["/c.txt"], destination: "/Ziel" });

    assert.deepStrictEqual(moved, [["/a.txt", "/Ziel"], ["/b.txt", "/Ziel"]]);
    assert.deepStrictEqual(copied, [["/c.txt", "/Ziel"]]);
});

test("a source list that is empty, absent or absurdly long is refused", async () => {
    const { handlers } = harness({ move: async () => { throw new Error("must not be called"); } });

    for (const sources of [undefined, [], "a", [""], [42], Array.from({ length: 257 }, () => "/a.txt")]) {
        await assert.rejects(handlers[OP.MOVE_FILES]({ sources, destination: "/Ziel" }), /sources/i,
            `accepted ${JSON.stringify(Array.isArray(sources) ? sources.length : sources)}`);
    }
});

test("a move without a destination is refused rather than defaulted to the drive root", async () => {
    const { handlers } = harness({ move: async () => { throw new Error("must not be called"); } });

    for (const destination of [undefined, "", 42]) {
        await assert.rejects(handlers[OP.MOVE_FILES]({ sources: ["/a.txt"], destination }), /destination/i,
            `accepted ${JSON.stringify(destination)}`);
    }
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

test("a socket that throws on send does not take the process down", () => {
    const send = createSend({ readyState: 1, send: () => { throw new Error("socket gone"); } });

    assert.doesNotThrow(() => send(OP.ERROR, { message: "anything" }));
});

test("nothing is written to a socket that is no longer open", () => {
    let wrote = 0;
    const send = createSend({ readyState: 3, send: () => { wrote += 1; } });

    send(OP.ERROR, { message: "anything" });

    assert.strictEqual(wrote, 0);
});

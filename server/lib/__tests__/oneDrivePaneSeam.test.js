const test = require("node:test");
const assert = require("node:assert");
const { OP } = require("../../routes/sftpWS");
const { buildOneDriveHandlers, ONEDRIVE_OPS } = require("../../routes/oneDriveWS");

// The client is ESM and lives under client/, the server is CommonJS — hence the dynamic import.
// paneRequests.js is deliberately free of JSX and of anything under client/node_modules, so the
// root test run can reach it without a client install.
const PANE_REQUESTS = "../../../client/src/pages/Servers/components/ViewContainer/renderer/FileRenderer/utils/paneRequests.js";

// Every earlier test on this seam pinned one side against itself: the handler table against
// ONEDRIVE_OPS, the request payloads against the components that build them. Both were green while
// the two sides disagreed on the fields behind four of the eight opcodes. This test is the only one
// that carries a payload across: the request comes from the client's builder, the handler is the
// server's, and the expectation is what the adapter was asked to do. Renaming a field on one side
// alone makes the handler reject the request its own client builds.
const SEAM = [
    {
        op: "LIST_FILES",
        request: (r) => r.listFilesRequest("/Documents"),
        expect: ["listDir", "/Documents"],
    },
    {
        op: "STAT",
        request: (r) => r.statRequest("/Documents/a.txt"),
        expect: ["stat", "/Documents/a.txt"],
    },
    {
        op: "CREATE_FOLDER",
        request: (r) => r.createFolderRequest("/Documents/New"),
        expect: ["mkdirRecursive", "/Documents/New"],
    },
    {
        // The empty-folder variant of the same opcode: an extra field, the same required one.
        op: "CREATE_FOLDER",
        request: (r) => r.createFolderRecursiveRequest("/Documents/Deep/Empty"),
        expect: ["mkdirRecursive", "/Documents/Deep/Empty"],
    },
    {
        op: "DELETE_FILE",
        request: (r) => r.deleteFileRequest("/Documents/a.txt"),
        expect: ["unlink", "/Documents/a.txt"],
    },
    {
        op: "DELETE_FOLDER",
        request: (r) => r.deleteFolderRequest("/Documents/Old"),
        expect: ["rmdir", "/Documents/Old", true],
    },
    {
        // Graph renames by name, the pane by target path — the handler derives one from the other.
        op: "RENAME_FILE",
        request: (r) => r.renameRequest("/Documents/old.txt", "/Documents/new.txt"),
        expect: ["rename", "/Documents/old.txt", "new.txt"],
    },
    {
        op: "MOVE_FILES",
        request: (r) => r.moveFilesRequest(["/a.txt", "/b.txt"], "/Documents"),
        expect: ["move", "/a.txt", "/Documents", "move", "/b.txt", "/Documents"],
    },
    {
        op: "COPY_FILES",
        request: (r) => r.copyFilesRequest(["/c.txt"], "/Documents"),
        expect: ["copy", "/c.txt", "/Documents"],
    },
];

const recordingAdapter = (calls) => {
    const record = (name, arity) => async (...args) => calls.push(name, ...args.slice(0, arity));
    return {
        listDir: async (path) => { calls.push("listDir", path); return []; },
        stat: async (path) => { calls.push("stat", path); return { size: 1, type: "file", mtime: 0, isSymlink: false }; },
        mkdirRecursive: record("mkdirRecursive", 1),
        unlink: record("unlink", 1),
        rmdir: record("rmdir", 2),
        rename: record("rename", 2),
        move: record("move", 2),
        copy: record("copy", 2),
    };
};

test("every request the pane builds is one the OneDrive socket accepts", async () => {
    const requests = await import(PANE_REQUESTS);

    for (const { op, request, expect } of SEAM) {
        const calls = [];
        const handlers = buildOneDriveHandlers(OP, { adapter: recordingAdapter(calls), send: () => {} });

        await handlers[OP[op]](request(requests));

        assert.deepStrictEqual(calls, expect, op);
    }
});

// Without this, the next opcode added to the drive gets a handler test and a client builder that
// still never meet — which is exactly how the four broken ones got here.
test("the seam test covers every opcode the drive offers", () => {
    assert.deepStrictEqual([...new Set(SEAM.map((entry) => OP[entry.op]))].sort(), [...ONEDRIVE_OPS].sort());
});

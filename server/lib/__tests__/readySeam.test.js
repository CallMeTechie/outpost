const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "../../routes/sftpWS.js"), "utf8");
const clientSource = fs.readFileSync(path.join(
    __dirname, "../../../client/src/pages/Servers/components/ViewContainer/renderer/FileRenderer/FileRenderer.jsx",
), "utf8");

test("the READY payload the server sends carries every field the client reads", () => {
    // The client reads payload.path, payload.capabilities and payload.restoredFrom. All three have
    // to appear in the object literal the server hands to sendResult for OP.READY.
    const readyCall = serverSource.match(/sendResult\(ws, OP\.READY, \{[^}]*\}\)/s);
    assert.ok(readyCall, "no sendResult(ws, OP.READY, {...}) found in sftpWS.js");
    for (const field of ["path", "restoredFrom", "capabilities"]) {
        assert.ok(readyCall[0].includes(field), `READY payload is missing "${field}"`);
    }
});

test("the client reads no READY field the server does not send", () => {
    const readyCall = serverSource.match(/sendResult\(ws, OP\.READY, \{[^}]*\}\)/s)[0];
    const readBlock = clientSource.match(/case OPERATIONS\.READY:[\s\S]*?break;/);
    assert.ok(readBlock, "no READY branch found in FileRenderer.jsx");
    const readFields = new Set([...readBlock[0].matchAll(/payload\?\.(\w+)/g)].map((m) => m[1]));
    for (const field of readFields) {
        assert.ok(readyCall.includes(field), `the client reads payload.${field}, the server never sends it`);
    }
});

test("PATH_SYNC still carries the field the server writes from", () => {
    assert.ok(serverSource.includes("payload?.path"), "the PATH_SYNC branch no longer reads payload.path");
});

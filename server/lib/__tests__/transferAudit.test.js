const test = require("node:test");
const assert = require("node:assert");
const { buildTransferAuditEntries } = require("../fileTransfer/transferAuth");
const { AUDIT_ACTIONS, RESOURCE_TYPES } = require("../../controllers/audit");

const base = {
    user: { id: "u1" },
    sourceScope: { organizationId: "org-src" },
    destScope: { organizationId: "org-dst" },
    sourceEntryId: "e-src", destEntryId: "e-dst",
    source: { kind: "sftp", sessionId: "s1" }, paths: ["/a", "/b"], destination: "/d", action: "move",
    ipAddress: "10.0.0.1", userAgent: "test",
};

test("two entries are produced, one per side", () => {
    const entries = buildTransferAuditEntries(base);
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries.map((e) => e.organizationId), ["org-src", "org-dst"]);
});

test("the source entry is a download, the destination an upload", () => {
    const [src, dst] = buildTransferAuditEntries(base);
    assert.strictEqual(src.action, AUDIT_ACTIONS.FILE_DOWNLOAD);
    assert.strictEqual(dst.action, AUDIT_ACTIONS.FILE_UPLOAD);
});

test("each side names the other, so the flow is reconstructable", () => {
    const [src, dst] = buildTransferAuditEntries(base);
    assert.strictEqual(src.details.destEntryId, "e-dst");
    assert.strictEqual(dst.details.sourceEntryId, "e-src");
});

test("the account and request metadata are carried on both", () => {
    for (const entry of buildTransferAuditEntries(base)) {
        assert.strictEqual(entry.accountId, "u1");
        assert.strictEqual(entry.ipAddress, "10.0.0.1");
        assert.strictEqual(entry.userAgent, "test");
    }
});

// A refusal is the more interesting event — it is the probing attempt.
test("a refused attempt is marked and needs no source scope", () => {
    const [entry] = buildTransferAuditEntries({ ...base, sourceScope: null, refused: true });
    assert.strictEqual(entry.details.refused, true);
    assert.strictEqual(entry.organizationId, "org-dst");
});

test("both entries are logged under the file resource type", () => {
    for (const entry of buildTransferAuditEntries(base)) {
        assert.strictEqual(entry.resource, RESOURCE_TYPES.FILE);
    }
});

// The refused entry is meant to record how many paths were probed, not which ones — the full
// list would leak the attempt's target into a log the destination org, which never authorized
// the source side, can already read.
test("a refused attempt logs how many paths were requested, not which ones", () => {
    const [entry] = buildTransferAuditEntries({ ...base, sourceScope: null, refused: true });
    assert.strictEqual(entry.details.paths, base.paths.length);
});

// The endpoint descriptor, not a bare id: a transfer can come from a session or from a personal
// OneDrive connection, and the trail has to say which without the reader guessing what kind of id
// a bare string was.
test("the source entry carries the source endpoint and the full path list", () => {
    const [src] = buildTransferAuditEntries(base);
    assert.deepStrictEqual(src.details.source, { kind: "sftp", sessionId: "s1" });
    assert.deepStrictEqual(src.details.paths, ["/a", "/b"]);
});

test("the destination entry carries the destination path", () => {
    const [, dst] = buildTransferAuditEntries(base);
    assert.strictEqual(dst.details.destination, "/d");
});

// The audit entry is a security trail: once built, it must not change under the caller's feet
// if the caller goes on to mutate the paths array it passed in.
test("the source entry keeps its own copy of paths, unaffected by later mutation of the caller's array", () => {
    const paths = ["/a", "/b"];
    const [src] = buildTransferAuditEntries({ ...base, paths });
    paths.push("/c");
    assert.deepStrictEqual(src.details.paths, ["/a", "/b"]);
});

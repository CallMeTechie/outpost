const test = require("node:test");
const assert = require("node:assert");
const { buildTransferAuditEntries } = require("../fileTransfer/transferAuth");
const { AUDIT_ACTIONS } = require("../../controllers/audit");

const base = {
    user: { id: "u1" },
    sourceScope: { organizationId: "org-src" },
    destScope: { organizationId: "org-dst" },
    sourceEntryId: "e-src", destEntryId: "e-dst",
    sourceSessionId: "s1", paths: ["/a", "/b"], destination: "/d", action: "move",
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

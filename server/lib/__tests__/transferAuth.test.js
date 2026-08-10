const test = require("node:test");
const assert = require("node:assert");
const { authorizeSource, authorizeDestination, TransferNotPermittedError } =
    require("../fileTransfer/transferAuth");
const { Permission } = require("../../permissions/registry");

const deps = (over = {}) => ({
    getSession: () => ({ accountId: "me", entryId: "src-entry", participants: new Map() }),
    getConnection: () => ({ sftpClient: {} }),
    findEntry: async (id) => ({ id, folderId: null, organizationId: "org", accountId: "me" }),
    resolveEntryScope: async (e) => ({ organizationId: e.organizationId, ownerAccountId: e.accountId }),
    validateEntryAccess: async () => ({ valid: true }),
    hasResourcePermission: async () => true,
    ...over,
});

const srcReq = (over = {}) => ({ user: { id: "me" }, sourceSessionId: "s-1", action: "copy", ...over });
const dstReq = (over = {}) => ({
    user: { id: "me" },
    destEntry: { id: "dst-entry", folderId: null, organizationId: "org", accountId: "me" },
    onConflict: "skip", sourceIsFolder: false, ...over,
});

test("the owner of the source session is allowed", async () => {
    const { sourceScope } = await authorizeSource(deps(), srcReq());
    assert.strictEqual(sourceScope.organizationId, "org");
});

test("a missing source session is refused", async () => {
    await assert.rejects(() => authorizeSource(deps({ getSession: () => null }), srcReq()),
        TransferNotPermittedError);
});

test("a source session without a live connection is refused", async () => {
    await assert.rejects(() => authorizeSource(deps({ getConnection: () => ({}) }), srcReq()),
        TransferNotPermittedError);
});

test("a stranger is refused", async () => {
    const d = deps({ getSession: () => ({ accountId: "other", entryId: "src-entry", participants: new Map() }) });
    await assert.rejects(() => authorizeSource(d, srcReq()), TransferNotPermittedError);
});

// A read-only viewer may watch a shared session but must not siphon files out of it.
test("a read-only participant is refused", async () => {
    const participants = new Map([[{}, { accountId: "me", writable: false }]]);
    const d = deps({ getSession: () => ({ accountId: "owner", entryId: "src-entry", participants }) });
    await assert.rejects(() => authorizeSource(d, srcReq()), TransferNotPermittedError);
});

test("a writable participant is allowed", async () => {
    const participants = new Map([[{}, { accountId: "me", writable: true }]]);
    const d = deps({ getSession: () => ({ accountId: "owner", entryId: "src-entry", participants }) });
    await assert.doesNotReject(() => authorizeSource(d, srcReq()));
});

test("a link share participant without an account is refused", async () => {
    const participants = new Map([[{}, { accountId: null, writable: true }]]);
    const d = deps({ getSession: () => ({ accountId: "owner", entryId: "src-entry", participants }) });
    await assert.rejects(() => authorizeSource(d, srcReq()), TransferNotPermittedError);
});

// A link-share socket has no resolved user at all. It must be refused like any other caller,
// not crash with a TypeError from reading `.id` off null — a distinguishable failure mode is
// exactly the kind of leak the uniform error exists to prevent.
test("a null user is refused instead of throwing", async () => {
    await assert.rejects(() => authorizeSource(deps(), srcReq({ user: null })), TransferNotPermittedError);
});

// If user.id were ever falsy (e.g. { id: null }), comparing it directly against a participant's
// accountId would let a link-share participant (also accountId: null) match by accident. The
// participant must never match on a falsy accountId, regardless of what user.id happens to be.
test("a link share participant with a null accountId never matches a userless caller", async () => {
    const participants = new Map([[{}, { accountId: null, writable: true }]]);
    const d = deps({ getSession: () => ({ accountId: "owner", entryId: "src-entry", participants }) });
    await assert.rejects(() => authorizeSource(d, srcReq({ user: { id: null } })), TransferNotPermittedError);
});

test("a source entry the user may not access is refused", async () => {
    const d = deps({ validateEntryAccess: async () => ({ code: 403, message: "nope" }) });
    await assert.rejects(() => authorizeSource(d, srcReq()), TransferNotPermittedError);
});

test("a missing source entry is refused", async () => {
    const d = deps({ findEntry: async () => null });
    await assert.rejects(() => authorizeSource(d, srcReq()), TransferNotPermittedError);
});

test("missing FILES_VIEW on the source is refused", async () => {
    const d = deps({ hasResourcePermission: async (_a, _o, p) => p !== Permission.FILES_VIEW });
    await assert.rejects(() => authorizeSource(d, srcReq()), TransferNotPermittedError);
});

test("missing FILES_DOWNLOAD on the source is refused", async () => {
    const d = deps({ hasResourcePermission: async (_a, _o, p) => p !== Permission.FILES_DOWNLOAD });
    await assert.rejects(() => authorizeSource(d, srcReq()), TransferNotPermittedError);
});

test("a move additionally needs FILES_MODIFY on the source", async () => {
    const d = deps({ hasResourcePermission: async (_a, _o, p) => p !== Permission.FILES_MODIFY });
    await assert.doesNotReject(() => authorizeSource(d, srcReq({ action: "copy" })));
    await assert.rejects(() => authorizeSource(d, srcReq({ action: "move" })), TransferNotPermittedError);
});

// undefined means "entry loaded with a reduced attribute set", null means "really personal".
// Telling them apart is the difference between an organization right and a system-wide one.
test("a scope with an undefined organization is refused", async () => {
    const d = deps({ resolveEntryScope: async () => ({ organizationId: undefined, ownerAccountId: undefined }) });
    await assert.rejects(() => authorizeSource(d, srcReq()), TransferNotPermittedError);
    await assert.rejects(() => authorizeDestination(d, dstReq()), TransferNotPermittedError);
});

// null is a valid, truly personal scope and must NOT be refused — only undefined (a reduced
// attribute set) is. A falsy check (`!scope.organizationId`) would wrongly reject this too.
test("a scope with a null organization (a truly personal entry) is allowed", async () => {
    const d = deps({ resolveEntryScope: async () => ({ organizationId: null, ownerAccountId: "me" }) });
    await assert.doesNotReject(() => authorizeSource(d, srcReq()));
    await assert.doesNotReject(() => authorizeDestination(d, dstReq()));
});

test("missing FILES_UPLOAD on the destination is refused", async () => {
    const d = deps({ hasResourcePermission: async (_a, _o, p) => p !== Permission.FILES_UPLOAD });
    await assert.rejects(() => authorizeDestination(d, dstReq()), TransferNotPermittedError);
});

// FILES_MODIFY is only required when the transfer may create directories or overwrite.
test("a plain skip-mode file copy does not need FILES_MODIFY on the destination", async () => {
    const seen = [];
    const d = deps({ hasResourcePermission: async (_a, _o, p) => { seen.push(p); return true; } });
    await authorizeDestination(d, dstReq({ onConflict: "skip", sourceIsFolder: false }));
    assert.strictEqual(seen.filter((p) => p === Permission.FILES_MODIFY).length, 0);
});

test("a folder copy needs FILES_MODIFY on the destination", async () => {
    const d = deps({ hasResourcePermission: async (_a, _o, p) => p !== Permission.FILES_MODIFY });
    await assert.rejects(() => authorizeDestination(d, dstReq({ sourceIsFolder: true })), TransferNotPermittedError);
});

test("onConflict other than skip needs FILES_MODIFY on the destination", async () => {
    const d = deps({ hasResourcePermission: async (_a, _o, p) => p !== Permission.FILES_MODIFY });
    await assert.rejects(() => authorizeDestination(d, dstReq({ onConflict: "ask" })), TransferNotPermittedError);
});

test("every refusal carries the same generic message", async () => {
    const cases = [
        [authorizeSource, deps({ getSession: () => null }), srcReq()],
        [authorizeSource, deps({ validateEntryAccess: async () => ({ code: 403 }) }), srcReq()],
        [authorizeSource, deps({ hasResourcePermission: async () => false }), srcReq()],
        [authorizeDestination, deps({ hasResourcePermission: async () => false }), dstReq()],
    ];
    const messages = new Set();
    for (const [fn, d, req] of cases) {
        const err = await fn(d, req).then(() => null, (e) => e);
        messages.add(err.message);
    }
    assert.strictEqual(messages.size, 1, "the message must not reveal which check failed");
});

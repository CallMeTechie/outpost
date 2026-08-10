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
    destSessionId: "d-1",
    destEntry: { id: "dst-entry", folderId: null, organizationId: "org", accountId: "me" },
    onConflict: "skip", sourceIsFolder: false, ...over,
});

// A destination session owned by someone else, with `me` taking part in it on the given terms.
const sharedDestSession = (writable) => ({
    getSession: () => ({ accountId: "owner", entryId: "dst-entry",
        participants: new Map([[{}, { accountId: "me", writable }]]) }),
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

// authorizeDestination is exported on its own and must not depend on authorizeSource having
// already screened `user` — the same uniform refusal applies here.
test("a null user is refused for the destination instead of throwing", async () => {
    await assert.rejects(() => authorizeDestination(deps(), dstReq({ user: null })), TransferNotPermittedError);
});

test("a destination user with a null id is refused instead of reaching hasResourcePermission", async () => {
    await assert.rejects(() => authorizeDestination(deps(), dstReq({ user: { id: null } })),
        TransferNotPermittedError);
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

// Fix round 6, Finding C: the source side has always demanded write access of a shared session;
// the destination side only ever checked organization permissions. A participant who joined a
// shared session read-only could therefore write into it by transfer, while an ordinary
// CREATE_FILE on the very same socket was refused. Both sides must now make the same demand.
test("a read-only participant of the destination session may not be transferred into", async () => {
    // Every organization permission granted (the default fake), so nothing but the session's own
    // read-only terms can be doing the refusing here.
    await assert.rejects(() => authorizeDestination(deps(sharedDestSession(false)), dstReq()),
        TransferNotPermittedError);
});

test("a writable participant of the destination session is allowed", async () => {
    await assert.doesNotReject(() => authorizeDestination(deps(sharedDestSession(true)), dstReq()));
});

// The mirror image, and the confusion this pair exists to rule out: session write access does not
// stand in for organization rights either. A participant who may write is still refused without
// FILES_UPLOAD, so neither check can quietly take over for the other.
test("session write access on the destination does not replace the upload permission", async () => {
    const d = deps({ ...sharedDestSession(true),
        hasResourcePermission: async (_a, _o, p) => p !== Permission.FILES_UPLOAD });
    await assert.rejects(() => authorizeDestination(d, dstReq()), TransferNotPermittedError);
});

test("a link share participant may not be transferred into either", async () => {
    const d = deps({ getSession: () => ({ accountId: "owner", entryId: "dst-entry",
        participants: new Map([[{}, { accountId: null, writable: true }]]) }) });
    await assert.rejects(() => authorizeDestination(d, dstReq()), TransferNotPermittedError);
});

test("a stranger to the destination session is refused", async () => {
    const d = deps({ getSession: () => ({ accountId: "owner", entryId: "dst-entry", participants: new Map() }) });
    await assert.rejects(() => authorizeDestination(d, dstReq()), TransferNotPermittedError);
});

test("a destination session that no longer exists is refused", async () => {
    await assert.rejects(() => authorizeDestination(deps({ getSession: () => null }), dstReq()),
        TransferNotPermittedError);
});

test("the owner of the destination session is allowed", async () => {
    await assert.doesNotReject(() => authorizeDestination(deps(), dstReq()));
});

test("every refusal carries the same generic message", async () => {
    const cases = [
        [authorizeSource, deps({ getSession: () => null }), srcReq()],
        [authorizeSource, deps({ validateEntryAccess: async () => ({ code: 403 }) }), srcReq()],
        [authorizeSource, deps({ hasResourcePermission: async () => false }), srcReq()],
        [authorizeDestination, deps({ hasResourcePermission: async () => false }), dstReq()],
        // The two the destination side must not be able to tell apart: "you may not write in this
        // session" and "you have no rights on this organization".
        [authorizeDestination, deps(sharedDestSession(false)), dstReq()],
        [authorizeDestination, deps({ getSession: () => null }), dstReq()],
    ];
    const messages = new Set();
    for (const [fn, d, req] of cases) {
        const err = await fn(d, req).then(() => null, (e) => e);
        messages.add(err.message);
    }
    assert.strictEqual(messages.size, 1, "the message must not reveal which check failed");
});

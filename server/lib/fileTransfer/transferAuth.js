const { Permission } = require("../../permissions/registry");
const { AUDIT_ACTIONS, RESOURCE_TYPES } = require("../../controllers/audit");
const { TransferNotPermittedError } = require("./transferErrors");

const refuse = () => { throw new TransferNotPermittedError(); };

// undefined means the entry was loaded with a reduced attribute set (wsAuth does that on shared
// sockets). hasResourcePermission would then fall back to system-wide rights, which checks no
// organization membership at all — so an undefined scope is a refusal, not a personal entry.
const requireScope = (scope) => {
    if (scope.organizationId === undefined) refuse();
    return scope;
};

// The one requirement both sides make of a shared session, in one place so they cannot drift
// apart: taking part in it is not enough, the participant has to be allowed to write. participants
// is a Map keyed by websocket and is emptied when a socket closes — there is no persistent history,
// so a non-owner whose tab is gone is no longer a participant. That is intended.
const requireWritableParticipant = (session, user) => {
    if (session.accountId === user.id) return;
    const participant = [...(session.participants?.values() ?? [])]
        // Redundant while the `user?.id` guard in both callers stands — user.id is truthy by then,
        // so a link-share participant's accountId: null could never equal it anyway. Kept as a
        // second line of defense: if that guard is ever loosened, this still stops a link-share
        // participant from matching by coincidence.
        .find((p) => p.accountId != null && p.accountId === user.id);
    // A read-only viewer may watch, not siphon — and not write either. Link shares have no
    // accountId at all.
    if (!participant || !participant.writable) refuse();
};

const authorizeSource = async (deps, { user, sourceSessionId, action }) => {
    const { getSession, getConnection, findEntry, resolveEntryScope, validateEntryAccess,
        hasResourcePermission } = deps;

    // A caller without a resolved identity (link-share sockets carry user: null) gets the same
    // uniform refusal as everyone else instead of crashing with a TypeError below. Refusing any
    // other falsy id (e.g. 0) is harmless too: account ids are auto-increment and start at 1, so
    // 0 never denotes a real account.
    if (!user?.id) refuse();

    // 1. The source session exists and still has a live connection.
    const session = getSession(sourceSessionId);
    if (!session) refuse();
    if (!getConnection(sourceSessionId)?.sftpClient) refuse();

    // 2. The user takes part in the source session WITH write access.
    requireWritableParticipant(session, user);

    // 3. The source entry, freshly loaded and put through the same access check the destination
    //    socket passed on connect. Permissions alone are not enough: this covers folder-inherited
    //    scope and personal entries.
    const sourceEntry = await findEntry(session.entryId);
    if (!sourceEntry) refuse();
    const access = await validateEntryAccess(user.id, sourceEntry);
    if (!access?.valid) refuse();

    // 4. Permissions on the EFFECTIVE organization of the source.
    const sourceScope = requireScope(await resolveEntryScope(sourceEntry));
    const needed = [Permission.FILES_VIEW, Permission.FILES_DOWNLOAD];
    if (action === "move") needed.push(Permission.FILES_MODIFY);
    for (const permission of needed) {
        if (!(await hasResourcePermission(user.id, sourceScope.organizationId, permission))) refuse();
    }

    return { sourceEntry, sourceScope };
};

// 5. Runs only after the source was authorized AND the folder probe ran on the source connection.
const authorizeDestination = async (deps, { user, destSessionId, destEntry, onConflict, sourceIsFolder }) => {
    const { getSession, resolveEntryScope, hasResourcePermission } = deps;

    // Same guard as authorizeSource, and for the same reason: this function is exported and
    // callable on its own, so it must not rely on authorizeSource having already screened `user`.
    if (!user?.id) refuse();

    // The same requirement the source side makes, on the session this transfer writes into. Only
    // organization permissions used to be checked here, which let a read-only participant of a
    // shared session write through a transfer while an ordinary CREATE_FILE on the very same
    // socket was refused. Organization rights and session write access are two different things:
    // FILES_UPLOAD says what this account may do on this organization's servers, not whether this
    // particular shared session was handed out read-only.
    const session = getSession(destSessionId);
    if (!session) refuse();
    requireWritableParticipant(session, user);

    const destScope = requireScope(await resolveEntryScope(destEntry));
    if (!(await hasResourcePermission(user.id, destScope.organizationId, Permission.FILES_UPLOAD))) refuse();
    // FILES_MODIFY only when the transfer may create directories or overwrite — decidable now,
    // unlike "did it actually overwrite".
    if (sourceIsFolder || onConflict !== "skip") {
        if (!(await hasResourcePermission(user.id, destScope.organizationId, Permission.FILES_MODIFY))) refuse();
    }

    return { destScope };
};

const ACTIONS = new Set(["copy", "move"]);
const CONFLICT_MODES = new Set(["ask", "overwrite", "skip"]);
// Restrictive on purpose: the id is used as part of a connection key. Verify this literal with a
// short `node -e` run against "a:b", "" and a 65-character string before trusting it.
const TRANSFER_ID = /^[A-Za-z0-9_-]{1,64}$/;
// The character class alone lets "__proto__", "constructor" and "prototype" through — harmless
// today, because the register uses Maps and the connection keys are prefixed, but all three would
// be sharp the moment anyone indexes a plain object by transfer id: they reach across the
// prototype chain into shared state. "toString", "valueOf" and "hasOwnProperty" are deliberately
// NOT on this list: a plain-object lookup keyed by one of them shadows an inherited method with a
// value on that one object, which breaks that object's own calls but reaches no other object and
// pollutes nothing shared — a robustness concern, not the pollution primitive this list exists to
// block.
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_TRANSFER_PATHS = 256;
const MAX_PATH_LENGTH = 4096;

const invalid = () => { throw new Error("Invalid transfer request"); };

const validateTransferStart = (payload, destSessionId) => {
    const p = payload ?? {};
    if (typeof p.transferId !== "string" || !TRANSFER_ID.test(p.transferId)) invalid();
    if (RESERVED_IDS.has(p.transferId)) invalid();
    if (typeof p.sourceSessionId !== "string" || p.sourceSessionId === "") invalid();
    // Source and destination on one session resolve to the same auxiliary client, which deadlocks
    // FileTransfer — and the throw would land behind the reservation, leaking a slot for good.
    if (p.sourceSessionId === destSessionId) invalid();
    if (typeof p.destination !== "string" || p.destination === "" || p.destination.length > MAX_PATH_LENGTH) invalid();
    if (!Array.isArray(p.paths) || p.paths.length === 0 || p.paths.length > MAX_TRANSFER_PATHS) invalid();
    if (p.paths.some((x) => typeof x !== "string" || x === "" || x.length > MAX_PATH_LENGTH)) invalid();

    const action = p.action ?? "copy";
    if (!ACTIONS.has(action)) invalid();

    // Not defaulted on an unknown value: onConflict decides in the destination check whether
    // FILES_MODIFY is required, so quietly turning a typo into "ask" would widen permissions.
    const onConflict = p.onConflict ?? "ask";
    if (!CONFLICT_MODES.has(onConflict)) throw new Error("Invalid conflict mode");

    return { transferId: p.transferId, sourceSessionId: p.sourceSessionId,
        destination: p.destination, paths: p.paths, action, onConflict };
};

const buildTransferAuditEntries = ({ user, sourceScope, destScope, sourceEntryId, destEntryId,
    sourceSessionId, paths, destination, action, ipAddress, userAgent, refused = false }) => {
    const common = { accountId: user.id, resource: RESOURCE_TYPES.FILE, ipAddress, userAgent };
    // A refusal happens before the source scope is known — it is logged on the destination side,
    // which is where the request arrived.
    if (refused) {
        return [{ ...common, organizationId: destScope?.organizationId ?? null,
            action: AUDIT_ACTIONS.FILE_DOWNLOAD,
            details: { refused: true, sourceSessionId, paths: paths.length } }];
    }
    return [
        // paths is copied: it is a security trail, and must not change if the caller mutates the
        // array it passed in after this entry was built.
        { ...common, organizationId: sourceScope.organizationId, action: AUDIT_ACTIONS.FILE_DOWNLOAD,
            details: { sourceSessionId, paths: [...paths], action, destEntryId } },
        { ...common, organizationId: destScope.organizationId, action: AUDIT_ACTIONS.FILE_UPLOAD,
            details: { sourceEntryId, destination, action } },
    ];
};

module.exports = { authorizeSource, authorizeDestination, TransferNotPermittedError,
    validateTransferStart, buildTransferAuditEntries, MAX_TRANSFER_PATHS };

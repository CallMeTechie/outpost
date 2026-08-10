const { Permission } = require("../../permissions/registry");

class TransferNotPermittedError extends Error {
    constructor() {
        // Deliberately uniform: the caller must not be able to tell a missing session from a
        // missing permission, or the source session id becomes a probe for foreign servers.
        super("Transfer not permitted");
        this.name = "TransferNotPermittedError";
    }
}

const refuse = () => { throw new TransferNotPermittedError(); };

// undefined means the entry was loaded with a reduced attribute set (wsAuth does that on shared
// sockets). hasResourcePermission would then fall back to system-wide rights, which checks no
// organization membership at all — so an undefined scope is a refusal, not a personal entry.
const requireScope = (scope) => {
    if (scope.organizationId === undefined) refuse();
    return scope;
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

    // 2. The user takes part in the source session WITH write access. participants is a Map keyed
    //    by websocket and is emptied when a socket closes — there is no persistent history, so a
    //    non-owner whose tab is gone is no longer a participant. That is intended.
    if (session.accountId !== user.id) {
        const participant = [...(session.participants?.values() ?? [])]
            // Redundant while the `user?.id` guard above stands — user.id is truthy by then, so
            // a link-share participant's accountId: null could never equal it anyway. Kept as a
            // second line of defense: if that guard is ever loosened, this still stops a
            // link-share participant from matching by coincidence.
            .find((p) => p.accountId != null && p.accountId === user.id);
        // A read-only viewer may watch, not siphon. Link shares have no accountId at all.
        if (!participant || !participant.writable) refuse();
    }

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
const authorizeDestination = async (deps, { user, destEntry, onConflict, sourceIsFolder }) => {
    const { resolveEntryScope, hasResourcePermission } = deps;

    // Same guard as authorizeSource, and for the same reason: this function is exported and
    // callable on its own, so it must not rely on authorizeSource having already screened `user`.
    if (!user?.id) refuse();

    const destScope = requireScope(await resolveEntryScope(destEntry));
    if (!(await hasResourcePermission(user.id, destScope.organizationId, Permission.FILES_UPLOAD))) refuse();
    // FILES_MODIFY only when the transfer may create directories or overwrite — decidable now,
    // unlike "did it actually overwrite".
    if (sourceIsFolder || onConflict !== "skip") {
        if (!(await hasResourcePermission(user.id, destScope.organizationId, Permission.FILES_MODIFY))) refuse();
    }

    return { destScope };
};

module.exports = { authorizeSource, authorizeDestination, TransferNotPermittedError };

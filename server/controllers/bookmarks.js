const db = require("../utils/database");
const FileBookmark = require("../models/FileBookmark");
const Entry = require("../models/Entry");
const { normalizeBookmarkPath, bookmarkPathHash } = require("../lib/bookmarkPath");
const { renumberPositions, orderRequestIsComplete } = require("../lib/bookmarkOrder");
const { resolveEntryScope, validateEntryAccess } = require("./entry");
const { hasResourcePermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");

// SQLite takes a database-wide write lock, so any second writer - another pane pinning a folder, or
// `authenticate` touching Session.lastActivity on a parallel request - loses with SQLITE_BUSY and
// Sequelize rejects the whole transaction. MySQL spells the same situation "Lock wait timeout
// exceeded". Neither is the caller's fault, and neither may become the 500 that SEC-ERR-01 and the
// spec's "the user never sees an error here" both rule out.
const isLockConflict = (error) =>
    /deadlock|SQLITE_BUSY|database is locked|lock wait timeout/i.test(error?.message ?? "");

// One retry, then give up: the losing transaction wrote nothing, so replaying it is safe.
const withLockRetry = async (run) => {
    try { return await run(); }
    catch (error) {
        if (!isLockConflict(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return run();
    }
};

// The second sort key is not cosmetic: two rows that ended up on the same position would otherwise
// come back in a dialect-dependent order, and the bar would reshuffle itself between two reloads.
const listBookmarks = (accountId, entryId) =>
    FileBookmark.findAll({ where: { accountId, entryId }, order: [["position", "ASC"], ["id", "ASC"]] });

// MAX+1 inside a transaction, not count() outside one: two panes pinning two different folders at
// the same moment both count 3 and both write position 3. The unique index does not catch that -
// the paths differ.
//
// Both the normalized path and its hash are written here and nowhere else: no route changes the
// path of an existing bookmark (PATCH takes only { name }), so the two cannot drift apart. A
// Sequelize hook would be the wrong place - it does not fire on Model.update.
const createBookmark = (accountId, entryId, { name, path }) => {
    const normalized = normalizeBookmarkPath(path);
    return withLockRetry(() => db.transaction(async (transaction) => {
        const highest = await FileBookmark.max("position", { where: { accountId, entryId }, transaction });
        return FileBookmark.create({
            accountId, entryId, name,
            path: normalized,
            pathHash: bookmarkPathHash(normalized),
            position: Number.isFinite(highest) ? highest + 1 : 0,
        }, { transaction });
    }));
};

// Static update, not instance.update(): server/utils/database.js sets `query: { raw: true }`
// globally, so every finder in this project returns a plain object with no instance methods at all.
// controllers/identity.js passes `raw: false` where it needs an instance; nothing here does.
const renameBookmark = async (accountId, id, name) => {
    // The affected-row count is not an existence check: MySQL counts changed rows, SQLite matched
    // ones, so renaming to the same name would 404 on one dialect only. Existence was already
    // settled by authorizeBookmark.
    await FileBookmark.update({ name }, { where: { id, accountId } });
};

// Read, delete and renumber in one transaction. Reading the rest outside it would let a POST land
// between the delete and the read, and the new bookmark - whose position came from a MAX that still
// included the deleted row - would be renumbered on top of an existing one.
const deleteBookmark = (accountId, id) =>
    withLockRetry(() => db.transaction(async (transaction) => {
        const bookmark = await FileBookmark.findOne({ where: { id, accountId }, transaction });
        if (!bookmark) return false;

        await FileBookmark.destroy({ where: { id, accountId }, transaction });

        // Closing the gap is not in the spec by name, but it follows from the column's invariant
        // ("position, gapless from 0"): a hole would make the next reorder's renumbering look like
        // a change nobody made.
        const rest = await FileBookmark.findAll({
            where: { accountId, entryId: bookmark.entryId },
            order: [["position", "ASC"], ["id", "ASC"]], transaction,
        });
        for (const { id: restId, position } of renumberPositions(rest.map((b) => b.id))) {
            await FileBookmark.update({ position }, { where: { id: restId, accountId }, transaction });
        }
        return true;
    }));

// Returns false when the id sets disagree OR when the write hit a lock; the route turns both into a
// 409. The read belongs inside the transaction: outside it, the comparison judges a state that may
// already be gone by the first UPDATE, and the 409 the whole strictness rests on becomes a coin
// toss. A lock conflict is the same situation as a stale list - reload and drop the ordering - so
// it must not surface as a 500 the spec says the user should never see.
const reorderBookmarks = async (accountId, entryId, ids) => {
    try {
        return await db.transaction(async (transaction) => {
            const existing = await FileBookmark.findAll({
                where: { accountId, entryId },
                order: [["position", "ASC"], ["id", "ASC"]], transaction,
            });
            if (!orderRequestIsComplete(ids, existing.map((b) => b.id))) return false;

            for (const { id, position } of renumberPositions(ids)) {
                await FileBookmark.update({ position }, { where: { id, accountId, entryId }, transaction });
            }
            return true;
        });
    } catch (error) {
        if (isLockConflict(error)) return false;
        throw error;
    }
};

// Two independent checks, and neither replaces the other: validateEntryAccess settles ownership and
// organization membership, hasResourcePermission settles the FILES_VIEW right, and the accountId
// filter in every query stops two accounts with access to the same server from seeing each other's
// bookmarks.
//
// Two traps, both of which look fine and neither of which bites:
//   1. validateEntryAccess is (accountId, entry, errorMessage, requiredPermission) and answers with
//      an OBJECT - { valid, entry } or { code, message }. `if (!await validateEntryAccess(...))`
//      tests an object, which is always truthy, so the check would pass every single time.
//   2. The permission check runs on the EFFECTIVE scope from resolveEntryScope, never on
//      entry.organizationId: an entry inside an organization folder carries null there, and
//      hasResourcePermission falls back to a system-wide check that verifies no ownership at all
//      when the organization is null - and FILES_VIEW is granted by default (permissions/registry).
//      Together those two would let any signed-in account write bookmarks onto anyone's personal
//      server entry.
//
// Every refusal is a 404, including "no access": a 403 would tell a caller which entry ids exist.
const authorizeEntry = async (accountId, entryIdRaw) => {
    const entryId = Number.parseInt(entryIdRaw, 10);
    if (!Number.isInteger(entryId) || entryId < 1) return { code: 400, message: "Invalid entry id." };

    const entry = await Entry.findByPk(entryId);
    const access = await validateEntryAccess(accountId, entry, "Server not found.");
    if (!access.valid) return { code: 404, message: "Server not found." };

    const { organizationId } = await resolveEntryScope(access.entry);
    if (!await hasResourcePermission(accountId, organizationId, Permission.FILES_VIEW))
        return { code: 403, message: "No permission to browse files on this server." };

    return { valid: true, entry: access.entry };
};

// The two /bookmarks/:id routes carry no entryId, so they resolve it from the row itself. Loading
// the row scoped to the account first, and answering 404 for anything else, keeps a foreign id
// indistinguishable from a nonexistent one. Without this, an account whose access to the server was
// revoked could still rename and delete its old bookmarks - SEC-RBAC-01 asks for the check on every
// route, not on three of five.
const authorizeBookmark = async (accountId, idRaw) => {
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isInteger(id) || id < 1) return { code: 400, message: "Invalid bookmark id." };

    const bookmark = await FileBookmark.findOne({ where: { id, accountId } });
    if (!bookmark) return { code: 404, message: "Bookmark not found." };

    const entryCheck = await authorizeEntry(accountId, bookmark.entryId);
    // The bookmark is this account's own row, so its existence is nothing left to hide - the entry
    // check's own code goes through unchanged (403 when FILES_VIEW was revoked, 404 when the server
    // itself is gone). Flattening both into 404 would hide a revoked permission from the one caller
    // entitled to see it, and Step 8's route test asserts exactly the 403.
    if (!entryCheck.valid) return entryCheck;

    return { valid: true, bookmark };
};

module.exports = {
    listBookmarks, createBookmark, renameBookmark, deleteBookmark, reorderBookmarks,
    authorizeEntry, authorizeBookmark,
};

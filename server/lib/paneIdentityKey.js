// The one place that turns "which identity is this session using" into the value that goes into
// the (accountId, entryId, identityId) key of file_pane_states.
//
// Why a function and not just the column default: Sequelize applies a defaultValue only when the
// field is `undefined`. session.configuration.identityId is `null` for ad-hoc credentials, and a
// null passed straight through fails with a notNull violation before it ever reaches the database
// - so the one case the placeholder exists for would never be written. Reading has the same
// problem from the other side: `where: { identityId: null }` becomes `IS NULL` and finds nothing.
//
// 0 is safe as the placeholder because identities.id is an autoIncrement primary key that nothing
// in the server sets by hand, and both dialects start at 1.
const paneIdentityKey = (session) => session?.configuration?.identityId ?? 0;

module.exports = { paneIdentityKey };

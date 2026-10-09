const test = require("node:test");
const assert = require("node:assert");
const { Sequelize } = require("sequelize");

// The models bind to server/utils/database at require time, which would open data/outpost.db.
const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false });
const databasePath = require.resolve("../../utils/database");
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: db };

const Session = require("../../models/Session");
const Account = require("../../models/Account");
const permission = require("../../utils/permission");
const browser = require("../browser");
const { BrowserPool } = require("../browser/BrowserPool");
const { Permission } = require("../../permissions/registry");

const ALLOWED = new Set([1, 2]);
// wsAuth takes hasAccountPermission apart at require time, so the stub has to be in place first.
permission.hasAccountPermission = async (accountId, wanted) => wanted === Permission.CONNECT_BROWSER && ALLOWED.has(accountId);
const { authenticateBrowserSession } = require("../../middlewares/wsAuth");

const fakeSocket = () => ({ closedWith: null, close(code, reason) { this.closedWith = { code, reason }; } });

test("the browser socket admits only the session's owner, and only with connect.browser", async (t) => {
    const tokens = { "tok-1": { id: 11, accountId: 1 }, "tok-3": { id: 13, accountId: 3 } };
    t.mock.method(Session, "findOne", async ({ where }) => tokens[where.token] ?? null);
    t.mock.method(Session, "update", async () => [1]);
    t.mock.method(Account, "findByPk", async (id) => ({ id, username: `user${id}` }));
    const pool = new BrowserPool({ getSettings: async () => ({}), launcher: {}, createVia: async () => {} });
    const mine = { id: "browser-mine", accountId: 1 };
    pool.sessions.set(mine.id, { session: mine });
    pool.sessions.set("browser-theirs", { session: { id: "browser-theirs", accountId: 2 } });
    pool.sessions.set("browser-three", { session: { id: "browser-three", accountId: 3 } });
    t.mock.method(browser, "getBrowserPool", () => pool);

    const foreign = fakeSocket();
    assert.strictEqual(await authenticateBrowserSession(foreign, { sessionToken: "tok-1", browserSessionId: "browser-theirs" }), null);
    assert.strictEqual(foreign.closedWith.code, 4007);

    const withoutPermission = fakeSocket();
    assert.strictEqual(await authenticateBrowserSession(withoutPermission, { sessionToken: "tok-3", browserSessionId: "browser-three" }), null);
    assert.strictEqual(withoutPermission.closedWith.code, 4403);

    const owner = fakeSocket();
    const context = await authenticateBrowserSession(owner, { sessionToken: "tok-1", browserSessionId: "browser-mine" });
    assert.strictEqual(owner.closedWith, null);
    assert.strictEqual(context.browserSession, mine);
    assert.deepStrictEqual([context.user.id, context.session.id], [1, 11]);
});

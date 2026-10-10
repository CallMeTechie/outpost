const test = require("node:test");
const assert = require("node:assert");
const { Sequelize } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const systemPermissions = new Map();
const organizationPermissions = new Map();
fake("../../../utils/database", db);
fake("../../../permissions/engine", {
    getSystemPermissions: async (accountId) => ({ isAdmin: false, permissions: systemPermissions.get(accountId) ?? [] }),
    getOrganizationPermissions: async (accountId, organizationId) => ({
        isOwner: false, isAdmin: false, permissions: organizationPermissions.get(`${accountId}:${organizationId}`) ?? [],
    }),
});

const Entry = require("../../../models/Entry");
const Folder = require("../../../models/Folder");
const Tag = require("../../../models/Tag");
const EntryTag = require("../../../models/EntryTag");
const OrganizationMember = require("../../../models/OrganizationMember");
const VaultItem = require("../../../models/VaultItem");
const VaultBinding = require("../../../models/VaultBinding");
const { visibleItems, findVisibleItem, itemRef, canManageItem, canRevealItem, canCreateFor, canUseVault } = require("../visibility");
const { VaultErrorCode } = require("../errors");

const ANNA = 1;
const BEN = 2;
const world = {};

const server = (values) => Entry.create({ type: "server", name: "server", config: { ip: "192.0.2.1", protocol: "ssh" }, ...values });
const item = (values) => VaultItem.create({
    type: "login", fields: { username: "admin", origins: ["https://nas.lan"] }, approvalRequired: true, allServers: false, ...values,
});
const bind = (vaultItem, kind, target) => VaultBinding.create({ itemId: vaultItem.id, kind, targetId: target.id });
const member = (accountId, organizationId, status = "active") =>
    OrganizationMember.create({ organizationId, accountId, status, role: "member", invitedBy: 99 });
const agentOn = (entry) => ({ keyId: 1, entryId: entry.id, agentType: "claude" });
const names = async (caller) => (await visibleItems(caller)).map((visible) => visible.name).sort();

test.before(async () => {
    await db.sync();
    systemPermissions.set(ANNA, ["vault.use"]);
    systemPermissions.set(BEN, ["vault.use"]);
    await member(ANNA, 10);
    await member(ANNA, 20, "pending");

    const home = await Folder.create({ name: "home", accountId: ANNA });
    const lab = await Folder.create({ name: "lab", accountId: ANNA, parentId: home.id });
    const team = await Folder.create({ name: "team", organizationId: 10 });
    const teamNas = await Folder.create({ name: "team-nas", organizationId: 10, parentId: team.id });
    const other = await Folder.create({ name: "other", organizationId: 20 });
    const prod = await Tag.create({ accountId: ANNA, name: "prod", color: "#ff0000" });

    world.sDirect = await server({ accountId: ANNA });
    world.sNested = await server({ accountId: ANNA, folderId: lab.id });
    world.sTagged = await server({ accountId: ANNA });
    world.sPlain = await server({ accountId: ANNA });
    world.sOrg = await server({ folderId: teamNas.id });
    world.sOrg20 = await server({ folderId: other.id });
    await EntryTag.create({ entryId: world.sTagged.id, tagId: prod.id });

    await bind(await item({ accountId: ANNA, name: "direct" }), "entry", world.sDirect);
    await bind(await item({ accountId: ANNA, name: "folder" }), "folder", home);
    await bind(await item({ accountId: ANNA, name: "tagged" }), "tag", prod);
    await item({ accountId: ANNA, name: "everywhere", allServers: true });
    await item({ accountId: ANNA, name: "unbound" });
    await bind(await item({ organizationId: 10, name: "org-folder" }), "folder", team);
    await item({ organizationId: 10, name: "org-all", allServers: true });
    await item({ organizationId: 20, name: "org20-all", allServers: true });
    await item({ accountId: BEN, name: "foreign-all", allServers: true });
});

test("Sichtbarkeit je Aufrufer und Server (Spec-Test 4)", async (t) => {
    t.after(async () => {
        systemPermissions.set(ANNA, ["vault.use"]);
        await OrganizationMember.destroy({ where: { accountId: ANNA, organizationId: 10 } });
        await member(ANNA, 10);
    });

    const cases = [
        ["Konto-Key oder Login-Session ohne Server: nur persönliche Einträge mit allServers", null, ["everywhere"]],
        ["Server direkt gebunden", "sDirect", ["direct", "everywhere"]],
        ["Ordnerbindung gilt auch für Server im Unterordner", "sNested", ["everywhere", "folder"]],
        ["Tag des Servers", "sTagged", ["everywhere", "tagged"]],
        ["keine Bindung; allServers der Organisation gilt nicht außerhalb der Organisation", "sPlain", ["everywhere"]],
        ["Server im Ordner der Organisation (entry.organizationId leer)", "sOrg", ["everywhere", "org-all", "org-folder"]],
        ["Organisation mit offener Einladung", "sOrg20", []],
    ];
    for (const [label, serverKey, expected] of cases) {
        const agent = serverKey ? agentOn(world[serverKey]) : null;
        assert.deepStrictEqual(await names({ accountId: ANNA, agent }), expected, label);
    }

    systemPermissions.set(ANNA, []);
    assert.deepStrictEqual(await names({ accountId: ANNA, agent: agentOn(world.sOrg) }), ["org-all", "org-folder"],
        "ohne vault.use keine persönlichen Einträge");
    assert.deepStrictEqual(await names({ accountId: ANNA, agent: null }), [], "ohne vault.use und ohne Server nichts");
    systemPermissions.set(ANNA, ["vault.use"]);

    await OrganizationMember.destroy({ where: { accountId: ANNA, organizationId: 10 } });
    assert.deepStrictEqual(await names({ accountId: ANNA, agent: agentOn(world.sOrg) }), [],
        "Organisation verlassen: der Server ist nicht mehr erreichbar, der Key sieht nichts, auch keine persönlichen Einträge");
    assert.deepStrictEqual(await names({ accountId: ANNA, agent: agentOn(world.sDirect) }), ["direct", "everywhere"]);
});

test("Kennungen: unbekannt, unsichtbar, fremd und ungültig ergeben denselben Fehler", async () => {
    const onOrg = { accountId: ANNA, agent: agentOn(world.sOrg) };
    const orgAll = await findVisibleItem(onOrg, "org:10/org-all");
    assert.deepStrictEqual([itemRef(orgAll), orgAll.allServers, orgAll.fields.username], ["org:10/org-all", true, "admin"]);
    assert.strictEqual(itemRef(await findVisibleItem(onOrg, "everywhere")), "everywhere");

    const attempts = [
        [{ accountId: ANNA, agent: agentOn(world.sDirect) }, "org:10/org-all"],
        [onOrg, "missing"],
        [onOrg, "foreign-all"],
        [onOrg, "org-all"],
        [onOrg, "org:10/../org-all"],
        [onOrg, 42],
    ];
    const failures = [];
    for (const [caller, ref] of attempts) {
        const error = await findVisibleItem(caller, ref).then(() => null, (thrown) => thrown);
        failures.push({ ref, code: error?.code, message: error?.message });
    }
    for (const failure of failures) assert.strictEqual(failure.code, VaultErrorCode.ITEM_UNKNOWN, String(failure.ref));
    assert.strictEqual(new Set(failures.map((failure) => failure.message)).size, 1);
});

test("Verwalten, Anzeigen, Anlegen und Vault-Zugang verlangen Besitz bzw. aktive Mitgliedschaft und Recht", async () => {
    const CARL = 3;
    const DORA = 4;
    const ADMIN = 5;
    systemPermissions.set(CARL, ["vault.use"]);
    await member(CARL, 30);
    organizationPermissions.set(`${CARL}:30`, ["vault.manage"]);
    await member(DORA, 30);
    organizationPermissions.set(`${DORA}:30`, ["vault.reveal"]);
    organizationPermissions.set(`${ADMIN}:30`, ["vault.manage", "vault.reveal"]);
    const own = { id: 900, accountId: CARL, organizationId: null };
    const doras = { id: 901, accountId: DORA, organizationId: null };
    const shared = { id: 902, accountId: null, organizationId: 30 };

    const rows = [
        ["Besitzer eines persönlichen Eintrags", CARL, own, true, true],
        ["persönlicher Eintrag eines anderen Kontos", CARL, doras, false, false],
        ["Besitzer ohne vault.use", DORA, doras, false, false],
        ["Mitglied mit vault.manage", CARL, shared, true, false],
        ["Mitglied mit vault.reveal", DORA, shared, false, true],
        ["Rechte ohne aktive Mitgliedschaft", ADMIN, shared, false, false],
    ];
    for (const [label, accountId, vaultItem, manage, reveal] of rows)
        assert.deepStrictEqual([await canManageItem(accountId, vaultItem), await canRevealItem(accountId, vaultItem)], [manage, reveal], label);

    assert.deepStrictEqual([
        await canCreateFor(CARL, { organizationId: null }),
        await canCreateFor(CARL, { organizationId: 30 }),
        await canCreateFor(DORA, { organizationId: 30 }),
        await canCreateFor(ADMIN, { organizationId: 30 }),
    ], [true, true, false, false]);

    assert.deepStrictEqual([await canUseVault(CARL), await canUseVault(DORA), await canUseVault(ADMIN)], [true, true, false],
        "vault.use oder aktive Mitgliedschaft");
});

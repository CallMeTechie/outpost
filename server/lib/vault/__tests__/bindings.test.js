const test = require("node:test");
const assert = require("node:assert");
const { Sequelize } = require("sequelize");

const db = new Sequelize({ dialect: "sqlite", storage: ":memory:", logging: false, query: { raw: true }, foreignKeys: false });
const fake = (path, exports) => {
    const resolved = require.resolve(path);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const systemPermissions = new Map();
fake("../../../utils/database", db);
fake("../../../permissions/engine", {
    getSystemPermissions: async (accountId) => ({ isAdmin: false, permissions: systemPermissions.get(accountId) ?? [] }),
    getOrganizationPermissions: async () => ({ isOwner: false, isAdmin: false, permissions: [] }),
    hasOrganizationPermission: async (accountId, organizationId, permission) => accountId === 1 && organizationId === 20 && permission === "org.delete",
});

const Entry = require("../../../models/Entry");
const Folder = require("../../../models/Folder");
const Tag = require("../../../models/Tag");
const Integration = require("../../../models/Integration");
const OrganizationMember = require("../../../models/OrganizationMember");
const VaultItem = require("../../../models/VaultItem");
const VaultBinding = require("../../../models/VaultBinding");
const { deleteEntry } = require("../../../controllers/entry");
const { deleteFolder } = require("../../../controllers/folder");
const { deleteTag } = require("../../../controllers/tag");
const { deleteIntegration } = require("../../../controllers/integration");
const { deleteOrganization } = require("../../../controllers/organization");
const { setBindings, validateBindings } = require("../bindings");

const ANNA = 1;
const BEN = 2;

const login = (name) => VaultItem.create({
    accountId: ANNA, name, type: "login", fields: { username: "admin", origins: ["https://nas.lan"] }, approvalRequired: true, allServers: false,
});
const remaining = async (itemId) =>
    (await VaultBinding.findAll({ where: { itemId } })).map((binding) => `${binding.kind}:${binding.targetId}`).sort();

test.before(async () => {
    await db.sync();
    systemPermissions.set(ANNA, ["vault.use", "resources.manage"]);
});

test("Ordner mit Unterordnern löschen entfernt Bindungen an Ordner, Unterordner und mitgelöschte Server (Review Focus 5)", async () => {
    const root = await Folder.create({ name: "lab", accountId: ANNA });
    const sub = await Folder.create({ name: "nas", accountId: ANNA, parentId: root.id });
    const subSub = await Folder.create({ name: "backup", accountId: ANNA, parentId: sub.id });
    const outside = await Folder.create({ name: "prod", accountId: ANNA });
    const servers = [];
    for (const folder of [root, sub, subSub, outside])
        servers.push(await Entry.create({ accountId: ANNA, folderId: folder.id, type: "server", name: folder.name }));
    const kept = servers[3];
    const item = await login("nas-admin");
    await setBindings(item.id, [
        ...[root, sub, subSub, outside].map((folder) => ({ kind: "folder", targetId: folder.id })),
        ...servers.map((entry) => ({ kind: "entry", targetId: entry.id })),
    ]);

    assert.deepStrictEqual(await deleteFolder(ANNA, root.id), { success: true });

    assert.deepStrictEqual(await remaining(item.id), [`entry:${kept.id}`, `folder:${outside.id}`].sort());
    assert.strictEqual(await Entry.count({ where: { id: servers.slice(0, 3).map((entry) => entry.id) } }), 0);
});

test("Server, Tag, Integration oder Organisation löschen entfernt genau deren Bindungen", async () => {
    const gone = await Entry.create({ accountId: ANNA, type: "server", name: "old-nas" });
    const stays = await Entry.create({ accountId: ANNA, type: "server", name: "new-nas" });
    const tag = await Tag.create({ accountId: ANNA, name: "prod", color: "#ff0000" });
    const pve = await Integration.create({ type: "proxmox", name: "pve", config: { ip: "192.0.2.80", port: 8006 }, status: "online" });
    const pveRoot = await Folder.create({ name: "pve", accountId: ANNA, integrationId: pve.id, type: "integration-root" });
    const pveVm = await Entry.create({ accountId: ANNA, folderId: pveRoot.id, integrationId: pve.id, type: "pve-qemu", name: "vm-100" });
    const orgFolder = await Folder.create({ name: "org", accountId: null, organizationId: 20 });
    const orgServer = await Entry.create({ accountId: null, organizationId: 20, type: "server", name: "org-nas" });
    const orgFolderServer = await Entry.create({ accountId: null, folderId: orgFolder.id, type: "server", name: "org-vm" });
    const item = await login("router");
    await setBindings(item.id, [
        ...[orgServer, orgFolderServer].map((entry) => ({ kind: "entry", targetId: entry.id })),
        { kind: "folder", targetId: orgFolder.id },
        { kind: "entry", targetId: gone.id },
        { kind: "entry", targetId: stays.id },
        { kind: "tag", targetId: tag.id },
        { kind: "folder", targetId: pveRoot.id },
        { kind: "entry", targetId: pveVm.id },
    ]);

    assert.deepStrictEqual(await deleteEntry(ANNA, gone.id), { success: true });
    assert.deepStrictEqual(await deleteTag(ANNA, tag.id), { success: true });
    assert.deepStrictEqual(await deleteIntegration(ANNA, pve.id), { success: true });
    assert.deepStrictEqual(await deleteOrganization(ANNA, "20"), { success: true });

    assert.deepStrictEqual(await remaining(item.id), [`entry:${stays.id}`]);
});

test("Bindungen nur an zugängliche Ziele, Organisationseinträge nur an Server und Ordner der eigenen Organisation", async () => {
    await OrganizationMember.create({ organizationId: 10, accountId: ANNA, status: "active", role: "member", invitedBy: 99 });
    const own = await Entry.create({ accountId: ANNA, type: "server", name: "own" });
    const ownFolder = await Folder.create({ name: "own", accountId: ANNA });
    const ownTag = await Tag.create({ accountId: ANNA, name: "own", color: "#00ff00" });
    const foreign = await Entry.create({ accountId: BEN, type: "server", name: "foreign" });
    const foreignTag = await Tag.create({ accountId: BEN, name: "foreign", color: "#0000ff" });
    const teamFolder = await Folder.create({ name: "team", organizationId: 10 });
    const teamServer = await Entry.create({ folderId: teamFolder.id, type: "server", name: "team" });
    const otherFolder = await Folder.create({ name: "other", organizationId: 20 });
    const personal = { accountId: ANNA, organizationId: null };
    const team = { accountId: ANNA, organizationId: 10 };
    const to = (kind, target) => ({ kind, targetId: typeof target === "number" ? target : target.id });

    const cases = [
        ["persönlich: eigener Server, Ordner und Tag", personal, [to("entry", own), to("folder", ownFolder), to("tag", ownTag)], true],
        ["persönlich: zugänglicher Server der Organisation", personal, [to("entry", teamServer)], true],
        ["persönlich: Server eines anderen Kontos", personal, [to("entry", foreign)], false],
        ["persönlich: Tag eines anderen Kontos", personal, [to("tag", foreignTag)], false],
        ["persönlich: Ziel existiert nicht", personal, [to("entry", 999999)], false],
        ["persönlich: unbekannte Art", personal, [to("group", 1)], false],
        ["Organisation: Server und Ordner der Organisation", team, [to("entry", teamServer), to("folder", teamFolder)], true],
        ["Organisation: Tag", team, [to("tag", ownTag)], false],
        ["Organisation: persönlicher Server", team, [to("entry", own)], false],
        ["Organisation: Ordner einer anderen Organisation", team, [to("folder", otherFolder)], false],
    ];
    for (const [label, owner, bindings, valid] of cases) {
        const result = await validateBindings(owner, bindings);
        assert.strictEqual(result.valid, valid, label);
        if (!valid) assert.match(result.message, /\S/, label);
    }
});

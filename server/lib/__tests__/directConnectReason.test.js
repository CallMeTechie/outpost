const test = require("node:test");
const assert = require("node:assert");
const OrganizationMember = require("../../models/OrganizationMember");
const audit = require("../../controllers/audit");

// Patched BEFORE the controller is required: it destructures this function at
// load time, so a later swap on the module object would never be seen. Each
// test file runs in its own process, so the load order here is ours to set.
let settingsByOrg = {};
audit.getOrganizationAuditSettingsInternal = async (orgId) => settingsByOrg[orgId] ?? null;

const { directConnectionReasonRequired } = require("../../controllers/serverSession");

// A one-off connection has no entry, so the audit policy cannot be read from
// one. It comes from the account's memberships instead -- that is what stops a
// user from sidestepping their organization's "reason required" rule by typing
// the same host by hand. These tests pin the two properties that matter: the
// rule still binds, and it binds on exactly the memberships the client can see.

// OrganizationMember is called through the module object, so swapping it per
// test is fine; the audit settings come from the module-level `settingsByOrg`.
const withStubs = async (memberships, settings, run) => {
    const findAll = OrganizationMember.findAll;
    const queries = [];
    OrganizationMember.findAll = async (query) => {
        queries.push(query);
        return memberships;
    };
    settingsByOrg = settings;
    try {
        return await run(queries);
    } finally {
        OrganizationMember.findAll = findAll;
        settingsByOrg = {};
    }
};

test("no memberships means no reason is demanded", async () => {
    await withStubs([], {}, async () => {
        assert.strictEqual(await directConnectionReasonRequired(7), false);
    });
});

test("a member of an organization that demands a reason cannot escape it", async () => {
    await withStubs([{ organizationId: 3 }], { 3: { requireConnectionReason: true } }, async () => {
        assert.strictEqual(await directConnectionReasonRequired(7), true);
    });
});

test("one demanding organization among several is enough", async () => {
    const orgs = { 1: { requireConnectionReason: false }, 2: null, 3: { requireConnectionReason: true } };
    await withStubs([{ organizationId: 1 }, { organizationId: 2 }, { organizationId: 3 }], orgs, async () => {
        assert.strictEqual(await directConnectionReasonRequired(7), true);
    });
});

test("organizations without the setting do not demand one", async () => {
    await withStubs([{ organizationId: 1 }, { organizationId: 2 }],
        { 1: { requireConnectionReason: false }, 2: null }, async () => {
            assert.strictEqual(await directConnectionReasonRequired(7), false);
        });
});

test("only active memberships count, matching what the client can see", async () => {
    // The entry tree the client reads the same policy from is built from
    // active memberships only (controllers/folder.js). Counting a pending
    // invitation here would demand a reason the client never asks for, and the
    // connection would dead-end on a 400 with no way to satisfy it.
    await withStubs([{ organizationId: 3 }], { 3: { requireConnectionReason: true } }, async (queries) => {
        await directConnectionReasonRequired(7);
        assert.deepStrictEqual(queries[0], { where: { accountId: 7, status: "active" } });
    });
});

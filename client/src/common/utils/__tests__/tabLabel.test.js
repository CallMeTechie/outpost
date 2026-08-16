import test from "node:test";
import assert from "node:assert";
import { buildTabLabel, assignNumbers, diffAssignments, tabGroupKey, tabIdentitySignature } from "../tabLabel.js";

// buildTabLabel only ever calls t() for the notes suffix and the tooltip's type value - both
// static label keys with no interpolation - so a small stub is enough, in the style
// transferDetail.test.js already uses to check translation-key composition without pulling in
// react-i18next or the locale files.
const t = (key) => ({
    "servers.notesPanel.title": "Notizen",
    "servers.tabLabel.type.terminal": "Terminal",
    "servers.tabLabel.type.sftp": "SFTP",
    "servers.tabLabel.type.notes": "Notes",
    "servers.tabLabel.type.onedrive": "OneDrive",
    "servers.tabLabel.type.remoteDesktop": "Remote desktop",
})[key];

const ssh = { id: "s1", type: "terminal", server: { name: "pve-01" } };
const tmux = { id: "s2", type: "terminal", server: { name: "pve-01" }, tmuxSession: "deploy" };
const sftp = { id: "s3", type: "sftp", server: { name: "pve-01" } };
const script = { id: "s4", type: "terminal", server: { name: "pve-01" }, scriptName: "backup.sh" };
const notes = { id: "s5", type: "notes", server: { name: "pve-01" } };
// OneDrive sessions carry no `server` object at all — only `oneDrive`.
const onedrive = { id: "onedrive-7", type: "onedrive", oneDrive: { displayName: "Firmen-Drive" } };
const joined = { id: "join-1", type: "terminal", server: { name: "pve-01" }, isJoined: true };

test("a plain session is just the server name", () => {
    assert.strictEqual(buildTabLabel(ssh, {}, t).text, "pve-01");
});

test("a tmux session carries its session name", () => {
    assert.strictEqual(buildTabLabel(tmux, {}, t).text, "pve-01 · deploy");
});

test("a scripted session carries its script name", () => {
    assert.strictEqual(buildTabLabel(script, {}, t).text, "pve-01 · backup.sh");
});

test("tmux wins over the script name when both are there", () => {
    assert.strictEqual(buildTabLabel({ ...tmux, scriptName: "backup.sh" }, {}, t).text, "pve-01 · deploy");
});

// A OneDrive session would throw on session.server.name — the access must stay optional.
test("a session without a server object falls back to the OneDrive name", () => {
    assert.strictEqual(buildTabLabel(onedrive, {}, t).text, "Firmen-Drive");
});

test("a notes session carries the notes suffix", () => {
    assert.strictEqual(buildTabLabel(notes, {}, t).text, "pve-01 (Notizen)");
});

test("a custom name replaces the base, keeping the type suffix", () => {
    assert.strictEqual(buildTabLabel(sftp, { name: "Backup" }, t).text, "Backup (SFTP)");
});

// Type first, number last: the type says what the tab is, the number says which of several.
test("the number comes after the type suffix", () => {
    assert.strictEqual(buildTabLabel(sftp, { number: 2 }, t).text, "pve-01 (SFTP) (2)");
});

test("a custom name suppresses the tmux discriminator", () => {
    assert.strictEqual(buildTabLabel(tmux, { name: "Deploy Prod" }, t).text, "Deploy Prod");
});

test("number 1 shows no suffix", () => {
    assert.strictEqual(buildTabLabel(ssh, { number: 1 }, t).text, "pve-01");
});

test("a joined session, which carries nothing extra, is just the server name", () => {
    assert.strictEqual(buildTabLabel(joined, {}, t).text, "pve-01");
});

// The tmux session name reaches the always-visible tab text, not just the tooltip. It can come
// from whatever sessions the host reports, so it needs the same treatment as a live title.
test("the tmux name is sanitised before it reaches the text", () => {
    assert.strictEqual(buildTabLabel({ ...tmux, tmuxSession: "de‮ploy" }, {}, t).text, "pve-01 · deploy");
});

test("a discriminator that sanitises to nothing leaves no dangling separator", () => {
    assert.strictEqual(buildTabLabel({ ...tmux, tmuxSession: "‮" }, {}, t).text, "pve-01");
});

// --- tooltip ---

// A plain terminal session carries no `type` at all - performConnection sends null and it arrives
// back as undefined - so this is the case a `tooltip.length > 0` assertion used to wave through
// while the type row was in fact missing from every ordinary terminal tab, leaving the tooltip
// saying only what the tab already said.
test("the tooltip carries a type row for a plain terminal session, which has no type field", () => {
    const { tooltip } = buildTabLabel({ id: "t1", server: { name: "pve-01" } }, {}, t);
    assert.ok(tooltip.some(field => field.key === "servers.tabLabel.tooltip.server" && field.value === "pve-01"));
    assert.ok(tooltip.some(field => field.key === "servers.tabLabel.tooltip.type" && field.value === "Terminal"));
});

// An RDP/VNC session is typeless in exactly the same way; only the renderer tells the two apart.
test("a Guacamole session gets the remote-desktop type, not the terminal one", () => {
    const { tooltip } = buildTabLabel({ id: "t2", server: { name: "win-01", renderer: "guac" } }, {}, t);
    assert.ok(tooltip.some(field => field.key === "servers.tabLabel.tooltip.type" && field.value === "Remote desktop"));
});

// The type value is the module's own vocabulary, not remote text - unlike the tmux session name,
// the script name or the live title, it goes through t() so a German UI doesn't show "Typ: Notes".
test("the tooltip's type value is translated through t()", () => {
    const { tooltip } = buildTabLabel(sftp, {}, t);
    assert.ok(tooltip.some(field => field.key === "servers.tabLabel.tooltip.type" && field.value === "SFTP"));
});

test("an unrecognised type falls back to the raw type string, untranslated", () => {
    const { tooltip } = buildTabLabel({ ...ssh, type: "carrier-pigeon" }, {}, t);
    assert.ok(tooltip.some(field => field.key === "servers.tabLabel.tooltip.type" && field.value === "carrier-pigeon"));
});

test("the tooltip carries the tmux window, which never reaches the text", () => {
    const { text, tooltip } = buildTabLabel({ ...tmux, tmuxWindowId: "@3" }, {}, t);
    assert.strictEqual(text, "pve-01 · deploy");
    assert.ok(tooltip.some(field => field.value === "@3"));
});

// Without this the renamed tab loses every hint of what it actually points at.
test("a custom name still shows the automatic text in the tooltip", () => {
    const { tooltip } = buildTabLabel(sftp, { name: "Backup" }, t);
    assert.ok(tooltip.some(field => field.value === "pve-01 (SFTP)"));
});

test("a live title reaches the tooltip and never the text", () => {
    const { text, tooltip } = buildTabLabel({ ...ssh, liveTitle: "~/deploy" }, {}, t);
    assert.strictEqual(text, "pve-01");
    assert.ok(tooltip.some(field => field.value === "~/deploy"));
});

test("a live title is sanitised and cut", () => {
    const { tooltip } = buildTabLabel({ ...ssh, liveTitle: "a‮" + "b".repeat(200) }, {}, t);
    const field = tooltip.find(f => f.value.startsWith("a"));
    assert.ok(!field.value.includes("‮"));
    assert.ok(field.value.length <= 80);
});

test("fields without a value never appear", () => {
    const { tooltip } = buildTabLabel(ssh, {}, t);
    assert.ok(tooltip.every(field => field.value !== "" && field.value != null));
});

// --- assignNumbers ---

// assignNumbers takes identities keyed by id ({ name?, number? }), the same shape buildTabLabel
// takes per-session - not the flat { id: number } map its own return value is. This turns a
// previous result back into valid input for the idempotence check below.
const toIdentities = (numbers) => Object.fromEntries(Object.entries(numbers).map(([id, number]) => [id, { number }]));

test("the first session of a name gets number one", () => {
    assert.deepStrictEqual(assignNumbers([ssh], {}), { s1: 1 });
});

test("a second session with the same text gets the next number", () => {
    assert.deepStrictEqual(assignNumbers([ssh, { ...ssh, id: "s9" }], {}), { s1: 1, s9: 2 });
});

test("different discriminators need no numbering apart", () => {
    const result = assignNumbers([tmux, { ...tmux, id: "s8", tmuxSession: "build" }], {});
    assert.strictEqual(result.s2, 1);
    assert.strictEqual(result.s8, 1);
});

// Idempotence is the property that makes call sites irrelevant: it may run on every list change.
test("running it again changes nothing", () => {
    const sessions = [ssh, { ...ssh, id: "s9" }];
    const first = assignNumbers(sessions, {});
    assert.deepStrictEqual(assignNumbers(sessions, toIdentities(first)), first);
});

test("a stored number is kept even when its neighbour is gone", () => {
    assert.deepStrictEqual(assignNumbers([{ ...ssh, id: "s9" }], { s9: { number: 2 } }), { s9: 2 });
});

// The gap is deliberate: closing a tab must never renumber the ones that stay. A closed session
// reserves its number through the group stored next to it - without that group there is nothing
// left to say which group the reservation belongs in.
test("a new session takes the next free number, leaving gaps", () => {
    const closed = { s9: { number: 2, group: tabGroupKey(ssh) } };
    assert.strictEqual(assignNumbers([{ ...ssh, id: "s7" }], closed).s7, 3);
});

// The regression that made every tab after the first one carry a number: the reservation used to
// be a single maximum over all entries regardless of group, so a number stored anywhere lifted the
// floor everywhere.
test("a number stored in one group does not raise a fresh session in another", () => {
    const other = { id: "x1", type: "terminal", server: { name: "host-B" } };
    const closed = { s9: { number: 7, group: tabGroupKey(other) } };
    assert.strictEqual(assignNumbers([{ ...ssh, id: "s7" }], closed).s7, 1);
});

// The same fault seen the way a user would: open a tab, then one on a different server, then a
// tmux tab on the first - each number handed out used to raise the floor for whatever came next,
// so the second tab read "host-B (2)" and the third "host-A · deploy (3)".
test("opening tabs on different servers in turn numbers none of them", () => {
    const a = { id: "a", type: "terminal", server: { name: "host-A" } };
    const b = { id: "b", type: "terminal", server: { name: "host-B" } };
    const c = { id: "c", type: "terminal", server: { name: "host-A" }, tmuxSession: "deploy" };

    let identities = {};
    for (const list of [[a], [a, b], [a, b, c]]) {
        const numbers = assignNumbers(list, identities);
        identities = Object.fromEntries(list.map(session => [session.id, {
            number: numbers[session.id],
            group: tabGroupKey(session, identities[session.id]),
        }]));
    }

    assert.deepStrictEqual(identities.a.number, 1);
    assert.deepStrictEqual(identities.b.number, 1);
    assert.deepStrictEqual(identities.c.number, 1);
});

// The reservation raises the floor for its own group and leaves every other group alone, in the
// same call: the SFTP tab starts above the closed SFTP tab, the terminal tab still starts at one.
test("a reservation raises its own group's floor and no other's", () => {
    const closed = { s9: { number: 4, group: tabGroupKey(sftp) } };
    const result = assignNumbers([ssh, sftp], closed);
    assert.strictEqual(result.s1, 1);
    assert.strictEqual(result.s3, 5);
});

// Entries written before the group field existed keep a valid number but cannot say where it
// belongs. Ignoring their reservation is the safe direction - a closed tab's number gets reused,
// which nobody can see, rather than a live tab being pushed off its own.
test("a stored number without a group reserves nothing", () => {
    assert.strictEqual(assignNumbers([{ ...ssh, id: "s7" }], { s9: { number: 2 } }).s7, 1);
});

test("two joined sessions, which have no discriminator at all, are separated by number alone", () => {
    const result = assignNumbers([joined, { ...joined, id: "join-2" }], {});
    assert.notStrictEqual(result["join-1"], result["join-2"]);
});

// A corrupt stored number - NaN, a string, zero, negative - must not leak into the result: the
// session it belongs to is treated as unnumbered and gets a fresh number like any other.
test("a corrupt stored number does not leak into the result", () => {
    for (const bad of [NaN, "abc", 0, -1]) {
        const result = assignNumbers([{ ...ssh, id: "s9" }], { s9: { number: bad } });
        assert.notStrictEqual(result.s9, bad);
        assert.ok(Number.isInteger(result.s9) && result.s9 > 0);
    }
});

// Math.max propagates NaN through every comparison it touches - a single corrupt entry must not
// turn the numbers every other session receives into NaN as a side effect.
test("a corrupt stored number does not affect the numbers other sessions receive", () => {
    const result = assignNumbers([{ ...ssh, id: "s7" }], { s9: { number: NaN } });
    assert.strictEqual(result.s7, 1);
});

// A terminal and a OneDrive session render with the same (empty) suffix, so two of them with the
// same base name render identically and must compete for the same number - grouping by raw
// session.type instead of the rendered suffix would keep them apart despite that.
test("a terminal and a OneDrive session with the same base name still number apart", () => {
    const term = { id: "a1", type: "terminal", server: { name: "Shared" } };
    const drive = { id: "od-1", type: "onedrive", oneDrive: { displayName: "Shared" } };
    const result = assignNumbers([term, drive], {});
    assert.strictEqual(result.a1, 1);
    assert.strictEqual(result["od-1"], 2);
});

// The group key has to account for a custom name, not just the automatic base - two sessions
// renamed to the same text must share a number sequence, or both could render as unnumbered
// duplicates of "Backup".
test("two sessions renamed to the same custom name still number apart", () => {
    const a = { id: "b1", type: "terminal", server: { name: "pve-01" } };
    const b = { id: "b2", type: "terminal", server: { name: "pve-02" } };
    const result = assignNumbers([a, b], { b1: { name: "Backup" }, b2: { name: "Backup" } });
    assert.notStrictEqual(result.b1, result.b2);
});

// Two sessions can each be an unremarkable "number 1" in their own, separate groups - invisible,
// since 1 shows no suffix - until a rename merges the groups and the same number collides. The
// order of the list handed in breaks the tie (not the tab strip's own order, which drag-and-drop
// rewrites independently): the earlier session keeps its number.
test("a rename that merges two groups resolves a duplicate number by list order", () => {
    const a = { id: "c1", type: "terminal", server: { name: "pve-01" } };
    const b = { id: "c2", type: "terminal", server: { name: "pve-02" } };
    const identities = { c1: { name: "Same Name", number: 1 }, c2: { name: "Same Name", number: 1 } };
    const result = assignNumbers([a, b], identities);
    assert.strictEqual(result.c1, 1);
    assert.notStrictEqual(result.c2, 1);
});

// --- tabIdentitySignature ---
//
// The signature is what decides whether numbering runs again. Anything groupKey reads has to move
// it; anything else must leave it alone, or numbering re-runs on every unrelated broadcast.

test("a changed server name moves the signature", () => {
    const before = tabIdentitySignature([ssh], {});
    const after = tabIdentitySignature([{ ...ssh, server: { name: "pve-02" } }], {});
    assert.notStrictEqual(before, after);
});

// This is the case that could not be seen from the tab strip: renaming the *server list* entry
// rebuilds every session with the new name, and two tabs that were number 1 in different groups
// land in the same group without anything renumbering them apart.
test("a server rename that merges two groups moves the signature", () => {
    const a = { id: "a", type: "terminal", server: { name: "alpha" } };
    const b = { id: "b", type: "terminal", server: { name: "beta" } };
    const before = tabIdentitySignature([a, b], {});
    const after = tabIdentitySignature([a, { ...b, server: { name: "alpha" } }], {});
    assert.notStrictEqual(before, after);
});

test("a changed OneDrive display name moves the signature", () => {
    const before = tabIdentitySignature([onedrive], {});
    const after = tabIdentitySignature([{ ...onedrive, oneDrive: { displayName: "Privat-Drive" } }], {});
    assert.notStrictEqual(before, after);
});

test("a changed custom name moves the signature", () => {
    const before = tabIdentitySignature([ssh], {});
    const after = tabIdentitySignature([ssh], { s1: { name: "Deploy Prod" } });
    assert.notStrictEqual(before, after);
});

test("a changed tmux session moves the signature", () => {
    assert.notStrictEqual(tabIdentitySignature([tmux], {}), tabIdentitySignature([{ ...tmux, tmuxSession: "build" }], {}));
});

test("a changed script name moves the signature", () => {
    assert.notStrictEqual(tabIdentitySignature([script], {}), tabIdentitySignature([{ ...script, scriptName: "restore.sh" }], {}));
});

test("a changed type moves the signature", () => {
    assert.notStrictEqual(tabIdentitySignature([ssh], {}), tabIdentitySignature([{ ...ssh, type: "sftp" }], {}));
});

// Hibernating or waking a session swaps which array holds it, and the caller concatenates the two.
test("reordering the same sessions leaves the signature alone", () => {
    assert.strictEqual(tabIdentitySignature([ssh, tmux], {}), tabIdentitySignature([tmux, ssh], {}));
});

// The fields that change several times a second - a lastActivity tick, a live terminal title -
// must not reach it, or numbering would run on every one of them.
test("a live title or an activity tick leaves the signature alone", () => {
    const before = tabIdentitySignature([ssh], {});
    assert.strictEqual(tabIdentitySignature([{ ...ssh, liveTitle: "~/deploy", lastActivity: 42 }], {}), before);
});

// The number itself is an output of numbering, not an input - if it moved the signature, writing
// a number back would retrigger the very computation that produced it.
test("a stored number leaves the signature alone", () => {
    assert.strictEqual(tabIdentitySignature([ssh], { s1: { number: 3 } }), tabIdentitySignature([ssh], {}));
});

// --- diffAssignments ---

test("an unchanged assignment reports no difference", () => {
    assert.strictEqual(diffAssignments({ a: 1 }, { a: 1 }), false);
});

test("an added session reports a difference", () => {
    assert.strictEqual(diffAssignments({ a: 1 }, { a: 1, b: 2 }), true);
});

test("a removed session reports a difference", () => {
    assert.strictEqual(diffAssignments({ a: 1, b: 2 }, { a: 1 }), true);
});

import test from "node:test";
import assert from "node:assert";
import { buildTabLabel, assignNumbers, diffAssignments } from "../tabLabel.js";

// buildTabLabel only ever calls t() for the notes suffix - a static label key with no
// interpolation - so a one-entry stub is enough, in the style transferDetail.test.js already
// uses to check translation-key composition without pulling in react-i18next or the locale files.
const t = (key) => ({ "servers.notesPanel.title": "Notizen" })[key];

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

test("the tooltip always carries server and type", () => {
    assert.ok(buildTabLabel(sftp, {}, t).tooltip.length > 0);
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
    assert.deepStrictEqual(assignNumbers(sessions, first), first);
});

test("a stored number is kept even when its neighbour is gone", () => {
    assert.deepStrictEqual(assignNumbers([{ ...ssh, id: "s9" }], { s9: 2 }), { s9: 2 });
});

// The gap is deliberate: closing a tab must never renumber the ones that stay.
test("a new session takes the next free number, leaving gaps", () => {
    assert.strictEqual(assignNumbers([{ ...ssh, id: "s7" }], { s9: 2 }).s7, 3);
});

test("two joined sessions, which have no discriminator at all, are separated by number alone", () => {
    const result = assignNumbers([joined, { ...joined, id: "join-2" }], {});
    assert.notStrictEqual(result["join-1"], result["join-2"]);
});

// A corrupt stored number - NaN, a string, zero, negative - must not leak into the result: the
// session it belongs to is treated as unnumbered and gets a fresh number like any other.
test("a corrupt stored number does not leak into the result", () => {
    for (const bad of [NaN, "abc", 0, -1]) {
        const result = assignNumbers([{ ...ssh, id: "s9" }], { s9: bad });
        assert.notStrictEqual(result.s9, bad);
        assert.ok(Number.isInteger(result.s9) && result.s9 > 0);
    }
});

// Math.max propagates NaN through every comparison it touches - a single corrupt entry must not
// turn the numbers every other session receives into NaN as a side effect.
test("a corrupt stored number does not affect the numbers other sessions receive", () => {
    const result = assignNumbers([{ ...ssh, id: "s7" }], { s9: NaN });
    assert.strictEqual(result.s7, 1);
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

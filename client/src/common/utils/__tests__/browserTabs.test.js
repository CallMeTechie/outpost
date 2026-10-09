import test from "node:test";
import assert from "node:assert";
import { syncBrowserTabs, toBrowserTab } from "../browserTabs.js";

const terminal = { id: "s1", type: "terminal", server: { name: "pve" } };
const item = (id, extra = {}) => ({ id, url: `https://${id}.test/`, title: id, origin: "agent", agentActive: false, agentPaused: false, via: null, ...extra });
const tab = (id, title = id) => ({ id, type: "browser", browser: { url: `https://${id}.test/`, title, agentActive: false, agentPaused: false, via: null } });

test("an agent session without a tab opens one and becomes active, next to the tabs already open", () => {
    const { sessions, activate } = syncBrowserTabs([terminal, tab("browser-a")], [item("browser-a"), item("browser-b")], new Set());
    assert.deepStrictEqual(sessions.map((s) => s.id), ["s1", "browser-a", "browser-b"]);
    assert.strictEqual(activate, "browser-b");
    assert.deepStrictEqual(sessions[2], tab("browser-b"));
});

test("a tab the user closed stays closed, and a session the user opened gets no tab by itself", () => {
    const { sessions, activate } = syncBrowserTabs([terminal], [item("browser-a"), item("browser-u", { origin: "user" })], new Set(["browser-a"]));
    assert.deepStrictEqual(sessions.map((s) => s.id), ["s1"]);
    assert.strictEqual(activate, null);
});

test("a session that is gone closes its tab; a changed title and agent state are carried over", () => {
    const { sessions, activate } = syncBrowserTabs([terminal, tab("browser-a"), tab("browser-b")], [item("browser-b", { title: "Grafana", agentActive: true })], new Set());
    assert.deepStrictEqual(sessions.map((s) => s.id), ["s1", "browser-b"]);
    assert.deepStrictEqual([sessions[1].browser.title, sessions[1].browser.agentActive], ["Grafana", true]);
    assert.strictEqual(activate, null);
});

test("an absent list is not read as 'nothing is open'", () => {
    const before = [terminal, tab("browser-a")];
    for (const list of [null, undefined]) assert.deepStrictEqual(syncBrowserTabs(before, list, new Set()), { sessions: before, activate: null });
});

test("a push that changes nothing returns the same array and reuses an unchanged tab", () => {
    const before = [terminal, tab("browser-a"), tab("browser-b")];
    assert.strictEqual(syncBrowserTabs(before, [item("browser-a"), item("browser-b")], new Set()).sessions, before);

    const { sessions } = syncBrowserTabs(before, [item("browser-a"), item("browser-b", { title: "Grafana" })], new Set());
    assert.notStrictEqual(sessions, before);
    assert.strictEqual(sessions[1], before[1]);
    assert.notStrictEqual(sessions[2], before[2]);
});

test("a tab the user opened survives the next push that contains it and is not added twice", () => {
    const opened = toBrowserTab(item("browser-u", { origin: "user", url: "about:blank" }));
    const before = [terminal, opened];
    const { sessions, activate } = syncBrowserTabs(before, [item("browser-u", { origin: "user", url: "https://a.test/", title: "A" })], new Set());
    assert.deepStrictEqual(sessions.map((s) => s.id), ["s1", "browser-u"]);
    assert.deepStrictEqual([sessions[1].browser.url, sessions[1].browser.title], ["https://a.test/", "A"]);
    assert.strictEqual(activate, null);
});

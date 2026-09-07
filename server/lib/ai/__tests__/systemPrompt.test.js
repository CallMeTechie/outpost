const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSystemPrompt } = require("../systemPrompt");

test("der Assistent nennt sich nach diesem Programm", async () => {
    // Der Fork hat den alten Produktnamen mitgebracht: bis 2026-09-07 stand hier
    // "You are the Nexterm assistant", und das Modell bekam ihn bei jeder Sitzung
    // vorgesetzt. Ein Test, weil ein Name im Prompt sonst nur beim Lesen auffällt.
    const prompt = await buildSystemPrompt(null);
    assert.match(prompt, /You are the Outpost assistant/);
    assert.doesNotMatch(prompt, /Nexterm/);
});

test("der Serverkontext steht im Prompt, wenn ein Eintrag da ist", async () => {
    const prompt = await buildSystemPrompt({
        id: 0, name: "nas", type: "server", config: { protocol: "ssh", ip: "192.168.2.151" },
    });
    assert.match(prompt, /Connected server:/);
    assert.match(prompt, /name: nas/);
    assert.match(prompt, /protocol: ssh/);
    assert.match(prompt, /host: 192\.168\.2\.151/);
});

test("ohne Eintrag bleibt der Prompt der Grundtext", async () => {
    const prompt = await buildSystemPrompt(null);
    assert.doesNotMatch(prompt, /Connected server:/);
});

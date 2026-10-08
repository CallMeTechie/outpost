const test = require("node:test");
const assert = require("node:assert");
const { RefTable, buildSnapshot } = require("../snapshot");

const node = (nodeId, role, name, extra = {}) => ({ nodeId, role: { type: "role", value: role }, name: { type: "computedString", value: name }, childIds: [], ...extra });

const page = () => [
    node("1", "RootWebArea", "Docs", { childIds: ["2", "3", "4", "5", "6", "7", "8"], backendDOMNodeId: 1 }),
    node("2", "heading", "Getting started", { backendDOMNodeId: 10, properties: [{ name: "level", value: { type: "integer", value: 1 } }] }),
    node("3", "link", "Documentation", { backendDOMNodeId: 11, parentId: "1" }),
    node("4", "generic", "", { ignored: true, childIds: ["9"], parentId: "1" }),
    node("5", "textbox", "Search", { backendDOMNodeId: 12, value: { type: "string", value: "cluster" }, parentId: "1" }),
    node("6", "checkbox", "Remember me", { backendDOMNodeId: 13, properties: [{ name: "checked", value: { type: "tristate", value: "true" } }], parentId: "1" }),
    node("7", "StaticText", "Plain text is not operable", { backendDOMNodeId: 14, parentId: "1" }),
    node("8", "button", "Sign in", { backendDOMNodeId: 15, properties: [{ name: "disabled", value: { type: "boolean", value: true } }], parentId: "1" }),
    node("9", "button", "Inside an ignored wrapper", { backendDOMNodeId: 16, parentId: "4" }),
];

test("the tree boils down to operable elements and headings, values carried over", () => {
    const text = buildSnapshot(page(), new RefTable());
    assert.strictEqual(text, [
        '- heading "Getting started" level=1',
        '- link "Documentation" [ref=e1]',
        '- button "Inside an ignored wrapper" [ref=e2]',
        '- textbox "Search" [ref=e3] value="cluster"',
        '- checkbox "Remember me" [ref=e4] checked',
        '- button "Sign in" [ref=e5] disabled',
    ].join("\n"));
});

test("the same element keeps its ref across snapshots; a new one gets the next number", () => {
    const refs = new RefTable();
    buildSnapshot(page(), refs);
    const grown = [...page(), node("10", "link", "New", { backendDOMNodeId: 17, parentId: "1" })];
    grown[0].childIds.push("10");
    const text = buildSnapshot(grown, refs);
    assert.match(text, /- link "Documentation" \[ref=e1\]/);
    assert.match(text, /- link "New" \[ref=e6\]/);
    assert.deepStrictEqual(refs.resolve("e3"), { backendNodeId: 12, label: 'textbox "Search"' });
});

test("a native select lists its options without refs of their own and keeps them at its ref", () => {
    const refs = new RefTable();
    const text = buildSnapshot([
        node("1", "RootWebArea", "", { childIds: ["2"] }),
        node("2", "combobox", "Country", { backendDOMNodeId: 20, parentId: "1", value: { type: "string", value: "Germany" }, childIds: ["3"] }),
        node("3", "MenuListPopup", "", { parentId: "2", childIds: ["4", "5"], ignored: true }),
        node("4", "MenuListOption", "France", { parentId: "3", backendDOMNodeId: 21 }),
        node("5", "MenuListOption", "Germany", { parentId: "3", backendDOMNodeId: 22, properties: [{ name: "selected", value: { type: "booleanOrUndefined", value: true } }] }),
    ], refs);
    assert.strictEqual(text, ['- combobox "Country" [ref=e1] value="Germany"', '  - option "France"', '  - option "Germany" selected'].join("\n"));
    assert.deepStrictEqual(refs.resolve("e1").options, [{ name: "France", selected: false }, { name: "Germany", selected: true }]);
});

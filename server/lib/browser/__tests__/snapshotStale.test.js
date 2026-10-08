const test = require("node:test");
const assert = require("node:assert");
const { RefTable, buildSnapshot } = require("../snapshot");
const { BrowserErrorCode } = require("../errors");

const tree = (backendDOMNodeId, name) => [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "" }, childIds: ["2"] },
    { nodeId: "2", role: { value: "button" }, name: { value: name }, childIds: [], parentId: "1", backendDOMNodeId },
];

test("a ref from before a navigation is refused as stale, never re-pointed at a new element", () => {
    const refs = new RefTable();
    assert.match(buildSnapshot(tree(10, "Old"), refs), /\[ref=e1\]/);

    refs.reset();
    assert.throws(() => refs.resolve("e1"), (err) => err.code === BrowserErrorCode.STALE_REF && /new snapshot/.test(err.message));

    assert.match(buildSnapshot(tree(20, "New"), refs), /- button "New" \[ref=e2\]/);
    assert.throws(() => refs.resolve("e1"), (err) => err.code === BrowserErrorCode.STALE_REF);
    assert.throws(() => refs.resolve("e99"), (err) => err.code === BrowserErrorCode.UNKNOWN_REF);
    assert.throws(() => refs.resolve("button"), (err) => err.code === BrowserErrorCode.UNKNOWN_REF);
});

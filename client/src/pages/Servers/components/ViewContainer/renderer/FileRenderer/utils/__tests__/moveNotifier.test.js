import test from "node:test";
import assert from "node:assert";
import { publishMoveCompleted, subscribeToMoveCompleted, paneAffectedByMove } from "../moveNotifier.js";

test("a subscriber is called with what was published", () => {
    const received = [];
    const unsubscribe = subscribeToMoveCompleted((event) => received.push(event));
    try {
        publishMoveCompleted({ sourceSessionId: "s1", paths: ["/a"] });
        assert.strictEqual(received.length, 1);
        assert.deepStrictEqual(received[0], { sourceSessionId: "s1", paths: ["/a"] });
    } finally {
        unsubscribe();
    }
});

test("every subscriber hears the same publish", () => {
    const a = [];
    const b = [];
    const unsubA = subscribeToMoveCompleted((event) => a.push(event));
    const unsubB = subscribeToMoveCompleted((event) => b.push(event));
    try {
        publishMoveCompleted({ sourceSessionId: "s1", paths: ["/a"] });
        assert.strictEqual(a.length, 1);
        assert.strictEqual(b.length, 1);
    } finally {
        unsubA();
        unsubB();
    }
});

test("unsubscribing actually stops delivery, and does not disturb the others", () => {
    const a = [];
    const b = [];
    const unsubA = subscribeToMoveCompleted((event) => a.push(event));
    const unsubB = subscribeToMoveCompleted((event) => b.push(event));
    try {
        unsubA();
        publishMoveCompleted({ sourceSessionId: "s1", paths: ["/a"] });
        assert.strictEqual(a.length, 0);
        assert.strictEqual(b.length, 1);
    } finally {
        unsubB();
    }
});

test("publishing with no subscribers left does not throw", () => {
    const unsubscribe = subscribeToMoveCompleted(() => {});
    unsubscribe();
    assert.doesNotThrow(() => publishMoveCompleted({ sourceSessionId: "s1", paths: ["/a"] }));
});

test("matching session with the exact directory the paths sit in is affected", () => {
    assert.strictEqual(paneAffectedByMove({
        sessionId: "s1", directory: "/home/user",
        sourceSessionId: "s1", paths: ["/home/user/file.txt"],
    }), true);
});

test("matching session but a different directory is not affected", () => {
    assert.strictEqual(paneAffectedByMove({
        sessionId: "s1", directory: "/home/other",
        sourceSessionId: "s1", paths: ["/home/user/file.txt"],
    }), false);
});

test("a different session is never affected, even with the same directory and paths", () => {
    assert.strictEqual(paneAffectedByMove({
        sessionId: "s1", directory: "/home/user",
        sourceSessionId: "s2", paths: ["/home/user/file.txt"],
    }), false);
});

test("an empty path list affects nothing", () => {
    assert.strictEqual(paneAffectedByMove({
        sessionId: "s1", directory: "/home/user",
        sourceSessionId: "s1", paths: [],
    }), false);
});

test("a missing path list affects nothing instead of throwing", () => {
    assert.strictEqual(paneAffectedByMove({
        sessionId: "s1", directory: "/home/user",
        sourceSessionId: "s1", paths: undefined,
    }), false);
});

test("a trailing slash on the shown directory does not break the match", () => {
    assert.strictEqual(paneAffectedByMove({
        sessionId: "s1", directory: "/home/user/",
        sourceSessionId: "s1", paths: ["/home/user/file.txt"],
    }), true);
});

test("a trailing slash on the moved path does not break the match", () => {
    assert.strictEqual(paneAffectedByMove({
        sessionId: "s1", directory: "/home/user",
        sourceSessionId: "s1", paths: ["/home/user/subfolder/"],
    }), true);
});

test("a path nested two levels below the shown directory is not affected", () => {
    assert.strictEqual(paneAffectedByMove({
        sessionId: "s1", directory: "/home/user",
        sourceSessionId: "s1", paths: ["/home/user/sub/deep/file.txt"],
    }), false);
});

test("one matching path among several is enough", () => {
    assert.strictEqual(paneAffectedByMove({
        sessionId: "s1", directory: "/home/user",
        sourceSessionId: "s1", paths: ["/elsewhere/other.txt", "/home/user/file.txt"],
    }), true);
});

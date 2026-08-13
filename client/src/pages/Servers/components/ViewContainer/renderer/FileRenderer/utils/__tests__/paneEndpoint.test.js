import test from "node:test";
import assert from "node:assert";
import { paneProvider, paneEndpoint, paneSocket, paneContentUrl, PROVIDER_SFTP, PROVIDER_ONEDRIVE }
    from "../paneEndpoint.js";

const sftp = { id: "sess-1", type: "sftp", server: { name: "web01" } };
const oneDrive = { id: "onedrive-7", type: "onedrive", oneDrive: { connectionId: 7, displayName: "Privat" } };

test("a session without a type is an SFTP pane", () => {
    assert.strictEqual(paneProvider({ id: "x" }), PROVIDER_SFTP);
    assert.strictEqual(paneProvider(undefined), PROVIDER_SFTP);
});

test("a OneDrive session is a OneDrive pane", () => {
    assert.strictEqual(paneProvider(oneDrive), PROVIDER_ONEDRIVE);
});

test("an SFTP pane keeps the address it has today", () => {
    assert.deepStrictEqual(paneSocket(sftp, "tok"),
        { path: "/api/ws/sftp", params: { sessionToken: "tok", sessionId: "sess-1" } });
});

test("a OneDrive pane addresses its own route by connection id", () => {
    assert.deepStrictEqual(paneSocket(oneDrive, "tok"),
        { path: "/api/ws/onedrive", params: { sessionToken: "tok", connectionId: 7 } });
});

test("the endpoint descriptor names the drive the server expects", () => {
    assert.deepStrictEqual(paneEndpoint(oneDrive), { kind: "onedrive", connectionId: 7, driveId: "me" });
    assert.deepStrictEqual(paneEndpoint(sftp), { kind: "sftp", sessionId: "sess-1" });
});

// A malformed session (missing or invalid required fields) must yield null instead of
// building an address the server rejects. The pane receives null and shows a read-only message
// instead of "connection lost" — task 4 relies on that behavior.
test("a OneDrive session without a usable connection id yields nothing", () => {
    for (const broken of [
        { id: "onedrive-x", type: "onedrive" },
        { id: "onedrive-x", type: "onedrive", oneDrive: {} },
        { id: "onedrive-x", type: "onedrive", oneDrive: { connectionId: "7" } },
        { id: "onedrive-x", type: "onedrive", oneDrive: { connectionId: 0 } },
        { id: "onedrive-x", type: "onedrive", oneDrive: { connectionId: -1 } },
        { id: "onedrive-x", type: "onedrive", oneDrive: { connectionId: 7.5 } },
    ]) {
        assert.strictEqual(paneSocket(broken, "tok"), null, JSON.stringify(broken));
        assert.strictEqual(paneEndpoint(broken), null, JSON.stringify(broken));
    }
});

test("an SFTP session without an id yields nothing", () => {
    assert.strictEqual(paneSocket({ type: "sftp" }, "tok"), null);
    assert.strictEqual(paneEndpoint({ type: "sftp" }), null);
    // Empty string id is not usable; it must fail the length guard.
    assert.strictEqual(paneSocket({ type: "sftp", id: "" }, "tok"), null);
    assert.strictEqual(paneEndpoint({ type: "sftp", id: "" }), null);
});

test("undefined session is handled safely (no throw during render)", () => {
    assert.strictEqual(paneSocket(undefined, "tok"), null);
    assert.strictEqual(paneEndpoint(undefined), null);
});

// Every one of these five must come out exactly as it did when each call site built its own
// string by hand — one test per purpose, matching the table in the task brief. A single byte off
// here (missing param, wrong order, an extra encode) is invisible until someone tries it against a
// real server.
test("an SFTP pane's download address is unchanged", () => {
    assert.strictEqual(paneContentUrl(sftp, "tok", { path: "/foo/bar.txt" }),
        "/api/entries/sftp?sessionId=sess-1&path=/foo/bar.txt&sessionToken=tok");
});

test("an SFTP pane's multi-download (ZIP) address is unchanged", () => {
    assert.strictEqual(paneContentUrl(sftp, "tok", { multi: true }),
        "/api/entries/sftp/multi?sessionId=sess-1&sessionToken=tok");
});

test("an SFTP pane's upload address is unchanged", () => {
    assert.strictEqual(paneContentUrl(sftp, "tok", { path: encodeURIComponent("/foo/bar.txt"), upload: true }),
        "/api/entries/sftp/upload?sessionId=sess-1&path=%2Ffoo%2Fbar.txt&sessionToken=tok");
});

test("an SFTP pane's thumbnail address is unchanged", () => {
    assert.strictEqual(paneContentUrl(sftp, "tok", { path: encodeURIComponent("/foo/bar.txt"), thumbnail: true, size: 100 }),
        "/api/entries/sftp?sessionId=sess-1&path=%2Ffoo%2Fbar.txt&sessionToken=tok&thumbnail=true&size=100");
});

test("an SFTP pane's preview address is unchanged", () => {
    assert.strictEqual(paneContentUrl(sftp, "tok", { path: "/foo/bar.txt", preview: true }),
        "/api/entries/sftp?sessionId=sess-1&path=/foo/bar.txt&sessionToken=tok&preview=true");
});

test("a OneDrive pane addresses the onedrive content route by connection id", () => {
    assert.strictEqual(paneContentUrl(oneDrive, "tok", { path: "/foo/bar.txt" }),
        "/api/entries/onedrive?connectionId=7&path=/foo/bar.txt&sessionToken=tok");
});

test("a OneDrive pane's multi-download address carries no sessionId", () => {
    assert.strictEqual(paneContentUrl(oneDrive, "tok", { multi: true }),
        "/api/entries/onedrive/multi?connectionId=7&sessionToken=tok");
});

// Same broken sessions paneSocket/paneEndpoint already refuse - a content URL built from half a
// session is a request the server rejects, so null here must reach the pane the same way.
test("an unusable session yields no content URL, not a half-built one", () => {
    assert.strictEqual(paneContentUrl({ type: "onedrive" }, "tok", { path: "/x" }), null);
    assert.strictEqual(paneContentUrl({ type: "sftp" }, "tok", { path: "/x" }), null);
    assert.strictEqual(paneContentUrl(undefined, "tok", { path: "/x" }), null);
});

import test from "node:test";
import assert from "node:assert";
import { paneProvider, paneEndpoint, paneSocket, PROVIDER_SFTP, PROVIDER_ONEDRIVE }
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

// Ohne diese vier Fälle baut ein halb gefülltes Sitzungsobjekt eine Adresse, die der Server
// ablehnt — und das Pane zeigt "Verbindung verloren" statt der Ursache.
test("a OneDrive session without a usable connection id yields nothing", () => {
    for (const broken of [
        { id: "onedrive-x", type: "onedrive" },
        { id: "onedrive-x", type: "onedrive", oneDrive: {} },
        { id: "onedrive-x", type: "onedrive", oneDrive: { connectionId: "7" } },
        { id: "onedrive-x", type: "onedrive", oneDrive: { connectionId: 0 } },
    ]) {
        assert.strictEqual(paneSocket(broken, "tok"), null, JSON.stringify(broken));
        assert.strictEqual(paneEndpoint(broken), null, JSON.stringify(broken));
    }
});

test("an SFTP session without an id yields nothing", () => {
    assert.strictEqual(paneSocket({ type: "sftp" }, "tok"), null);
    assert.strictEqual(paneEndpoint({ type: "sftp" }), null);
});

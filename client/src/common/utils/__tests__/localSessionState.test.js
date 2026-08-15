import test from "node:test";
import assert from "node:assert";
import { toLocalSessionDescriptor, restoreLocalSessions, canPersistLocalSessions, RESTORE_STATUS } from "../localSessionState.js";

const oneDriveSession = { id: "onedrive-7", type: "onedrive", oneDrive: { connectionId: 7, displayName: "Privat", microsoftEmail: "a@b.com" } };
const notesSession = { id: "notes-42", type: "notes", server: { id: 42, name: "web01" }, organizationId: null, organizationName: null };

test("a OneDrive session is stored as just its connection id", () => {
    assert.deepStrictEqual(toLocalSessionDescriptor(oneDriveSession), { type: "onedrive", connectionId: 7 });
});

test("a notes session is stored as just its server id", () => {
    assert.deepStrictEqual(toLocalSessionDescriptor(notesSession), { type: "notes", serverId: 42 });
});

// The whole point of isLocalSession in Servers.jsx: sessions the server already tracks
// (terminal, SFTP, joined) must never be written to localStorage.
test("a server-backed session yields no descriptor", () => {
    assert.strictEqual(toLocalSessionDescriptor({ id: "sess-1", type: "terminal", server: { id: 1 } }), undefined);
    assert.strictEqual(toLocalSessionDescriptor({ id: "sess-2", type: "sftp", server: { id: 1 } }), undefined);
    assert.strictEqual(toLocalSessionDescriptor(undefined), undefined);
});

test("a OneDrive session missing a usable connection id yields no descriptor", () => {
    assert.strictEqual(toLocalSessionDescriptor({ type: "onedrive" }), undefined);
    assert.strictEqual(toLocalSessionDescriptor({ type: "onedrive", oneDrive: {} }), undefined);
});

test("a notes session missing a server yields no descriptor", () => {
    assert.strictEqual(toLocalSessionDescriptor({ type: "notes" }), undefined);
    assert.strictEqual(toLocalSessionDescriptor({ type: "notes", server: {} }), undefined);
});

test("a connected OneDrive descriptor is rebuilt fresh from the connections list", () => {
    const connections = [{ id: 7, displayName: "Renamed", microsoftEmail: "a@b.com", status: "connected" }];
    const restored = restoreLocalSessions([{ type: "onedrive", connectionId: 7 }], { connections });
    assert.deepStrictEqual(restored, [{
        id: "onedrive-7",
        type: "onedrive",
        oneDrive: { connectionId: 7, displayName: "Renamed", microsoftEmail: "a@b.com" },
    }]);
});

// Rule 2 from the owner: a tab pointing at a connection that no longer connects is noise,
// not an error state, so it must not come back - silently, no dropped-tab notice either.
test("a disconnected OneDrive connection is not restored", () => {
    const connections = [{ id: 7, displayName: "Privat", status: "disconnected" }];
    assert.deepStrictEqual(restoreLocalSessions([{ type: "onedrive", connectionId: 7 }], { connections }), []);
});

test("a OneDrive connection that no longer exists is not restored", () => {
    assert.deepStrictEqual(restoreLocalSessions([{ type: "onedrive", connectionId: 7 }], { connections: [] }), []);
});

test("a notes descriptor is rebuilt through getServerById", () => {
    const server = { id: 42, name: "web01" };
    const restored = restoreLocalSessions([{ type: "notes", serverId: 42 }], { getServerById: (id) => id === 42 ? server : null });
    assert.deepStrictEqual(restored, [{ server, id: "notes-42", type: "notes" }]);
});

test("a notes descriptor for a deleted server is not restored", () => {
    const restored = restoreLocalSessions([{ type: "notes", serverId: 42 }], { getServerById: () => null });
    assert.deepStrictEqual(restored, []);
});

test("an unknown descriptor kind is dropped rather than throwing", () => {
    assert.deepStrictEqual(restoreLocalSessions([{ type: "mystery", id: 1 }], {}), []);
});

test("missing context (no connections, no getServerById) drops everything safely", () => {
    assert.deepStrictEqual(restoreLocalSessions([{ type: "onedrive", connectionId: 7 }, { type: "notes", serverId: 1 }]), []);
});

test("garbage in the descriptor list (corrupted localStorage) is skipped without throwing", () => {
    assert.deepStrictEqual(restoreLocalSessions([null, undefined, 42, "x", { type: "notes", serverId: 42 }], {
        getServerById: (id) => id === 42 ? { id: 42 } : null,
    }), [{ server: { id: 42 }, id: "notes-42", type: "notes" }]);
});

test("restoreLocalSessions handles a non-array input safely", () => {
    assert.deepStrictEqual(restoreLocalSessions(null, {}), []);
    assert.deepStrictEqual(restoreLocalSessions(undefined, {}), []);
});

// The rule the save effect leans on entirely: a save may only proceed once restore has
// read a complete picture. PENDING (restore hasn't run yet, e.g. right after mount) and
// FAILED (restore ran but its network read failed) must both refuse - collapsing them into
// one "not ready" value is exactly the mistake that let the save effect overwrite the still-
// unread descriptors on the very first render.
test("a save may only proceed once restore is READY", () => {
    assert.strictEqual(canPersistLocalSessions(RESTORE_STATUS.READY), true);
    assert.strictEqual(canPersistLocalSessions(RESTORE_STATUS.PENDING), false);
    assert.strictEqual(canPersistLocalSessions(RESTORE_STATUS.FAILED), false);
});

test("an unrecognized or missing restore status refuses to persist too", () => {
    assert.strictEqual(canPersistLocalSessions(undefined), false);
    assert.strictEqual(canPersistLocalSessions(null), false);
    assert.strictEqual(canPersistLocalSessions("done"), false);
});

test("mixed descriptors: only the rebuildable ones survive, order preserved", () => {
    const connections = [{ id: 7, displayName: "Privat", status: "connected" }];
    const server = { id: 42, name: "web01" };
    const restored = restoreLocalSessions([
        { type: "onedrive", connectionId: 7 },
        { type: "onedrive", connectionId: 9 },
        { type: "notes", serverId: 42 },
        { type: "notes", serverId: 99 },
    ], { connections, getServerById: (id) => id === 42 ? server : null });

    assert.deepStrictEqual(restored, [
        { id: "onedrive-7", type: "onedrive", oneDrive: { connectionId: 7, displayName: "Privat", microsoftEmail: undefined } },
        { server, id: "notes-42", type: "notes" },
    ]);
});

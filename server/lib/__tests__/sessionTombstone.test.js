const test = require("node:test");
const assert = require("node:assert");
const SessionManager = require("../SessionManager");

const retire = async (configuration, options = { code: 4017, reason: "Connection lost" }, { accountId = 1, entryId = 2 } = {}) => {
    const session = SessionManager.create(accountId, entryId, configuration, "maintenance", "tab-1", "browser-1", 11, null);
    await SessionManager.remove(session.sessionId, options);
    return session.sessionId;
};

test("ein Fehlerende eines unterstützten Protokolls hinterlässt einen Tombstone, alles andere nicht", async () => {
    const directIdentity = { type: "password", username: "u", password: "p" };
    const id = await retire({ protocol: "ssh", type: null, scriptId: null, directIdentity, tmuxSession: "claude" });
    const tombstone = SessionManager.getTombstone(id);
    assert.deepStrictEqual(
        {
            accountId: tombstone.accountId, entryId: tombstone.entryId, generation: tombstone.generation,
            reason: tombstone.reason, connectionReason: tombstone.connectionReason,
            tabId: tombstone.tabId, browserId: tombstone.browserId,
        },
        {
            accountId: 1, entryId: 2, generation: 1, reason: "Connection lost", connectionReason: "maintenance",
            tabId: "tab-1", browserId: "browser-1",
        },
    );
    assert.deepStrictEqual(tombstone.configuration.directIdentity, directIdentity);
    assert.strictEqual(tombstone.configuration.tmuxSession, "claude");

    for (const protocol of ["telnet", "pve-lxc", "rdp", "vnc"]) {
        assert.ok(SessionManager.getTombstone(await retire({ protocol })), `${protocol} should be retired`);
    }

    const refused = [
        [{ protocol: "ssh" }, {}],
        [{ protocol: "ssh" }, { code: 1000 }],
        [{ protocol: "pve-shell" }, { code: 4017 }],
        [{ protocol: "pve-qemu" }, { code: 4017 }],
        [{ protocol: "ssh", type: "sftp" }, { code: 4017 }],
        [{ protocol: "ssh", scriptId: 5 }, { code: 4017 }],
    ];
    for (const [configuration, options] of refused) {
        assert.strictEqual(SessionManager.getTombstone(await retire(configuration, options)), null,
            JSON.stringify([configuration, options]));
    }
});

test("ein Tombstone läuft nach 15 Minuten ab", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const id = await retire({ protocol: "ssh" });
    t.mock.timers.tick(SessionManager.TOMBSTONE_TTL_MS - 1);
    assert.ok(SessionManager.getTombstone(id));
    t.mock.timers.tick(1);
    assert.strictEqual(SessionManager.getTombstone(id), null);
});

test("Abmelden und Löschen eines Eintrags verwerfen auch die Tombstones", async () => {
    const own = await retire({ protocol: "ssh" }, undefined, { accountId: 41, entryId: 7 });
    const other = await retire({ protocol: "ssh" }, undefined, { accountId: 42, entryId: 7 });
    const otherEntry = await retire({ protocol: "ssh" }, undefined, { accountId: 42, entryId: 8 });

    await SessionManager.removeAllByAccountId(41);
    assert.strictEqual(SessionManager.getTombstone(own), null);
    assert.ok(SessionManager.getTombstone(other));

    await SessionManager.removeAllByEntryId(7);
    assert.strictEqual(SessionManager.getTombstone(other), null);
    assert.ok(SessionManager.getTombstone(otherEntry));
});

test("Engine-ID-Format, belegte ID und Wächter für setConnection/markFailed/remove", async () => {
    const configuration = { protocol: "ssh" };
    const first = SessionManager.create(1, 2, configuration);
    const { sessionId } = first;
    assert.strictEqual(first.generation, 1);
    assert.strictEqual(first.engineSessionId, sessionId);
    assert.throws(() => SessionManager.create(1, 2, configuration, null, null, null, null, null, { sessionId, generation: 2 }),
        /still in use/);

    await SessionManager.remove(sessionId, { code: 4017, reason: "Connection lost" });
    const second = SessionManager.create(1, 2, configuration, null, null, null, null, null, { sessionId, generation: 2 });
    assert.strictEqual(second.engineSessionId, `${sessionId}:2`);
    assert.deepStrictEqual(SessionManager.resolveEngineSession(second.engineSessionId), { sessionId, generation: 2 });
    assert.deepStrictEqual(SessionManager.resolveEngineSession(sessionId), { sessionId, generation: 1 });
    assert.strictEqual(SessionManager.resolveEngineSession(`${sessionId}-xfer-1`), null);
    assert.strictEqual(SessionManager.resolveEngineSession(`${sessionId}:2;rm -rf /`), null);

    assert.strictEqual(await SessionManager.remove(sessionId, { generation: 1 }), false);
    assert.strictEqual(SessionManager.setConnection(sessionId, { type: "ssh" }, 1), false);
    SessionManager.markFailed(sessionId, "stale", 1);

    assert.strictEqual(SessionManager.get(sessionId), second);
    assert.strictEqual(second.masterConnection, null);
    assert.strictEqual(SessionManager.consumeFailedReason(sessionId), null);
    await SessionManager.remove(sessionId);
});

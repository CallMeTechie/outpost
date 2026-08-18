import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateLegacyStorageKeys } from "../storageMigration.js";

const fakeStorage = (initial = {}) => {
    const data = { ...initial };
    return {
        data,
        get length() { return Object.keys(data).length; },
        key: (i) => Object.keys(data)[i] ?? null,
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        removeItem: (k) => { delete data[k]; },
    };
};

test("moves a legacy key to the new prefix", () => {
    const s = fakeStorage({ nexterm_server_url: "https://example.test" });
    migrateLegacyStorageKeys([s]);
    assert.strictEqual(s.getItem("outpost_server_url"), "https://example.test");
    assert.strictEqual(s.getItem("nexterm_server_url"), null);
});

test("does not overwrite a value that already exists under the new name", () => {
    const s = fakeStorage({ nexterm_browser_id: "old", outpost_browser_id: "new" });
    migrateLegacyStorageKeys([s]);
    assert.strictEqual(s.getItem("outpost_browser_id"), "new");
    assert.strictEqual(s.getItem("nexterm_browser_id"), null);
});

test("leaves unrelated keys alone", () => {
    const s = fakeStorage({ theme: "dark", nexterm_servers: "[]" });
    migrateLegacyStorageKeys([s]);
    assert.strictEqual(s.getItem("theme"), "dark");
    assert.strictEqual(s.getItem("outpost_servers"), "[]");
});

test("is safe to run twice", () => {
    const s = fakeStorage({ nexterm_active_server: "a" });
    migrateLegacyStorageKeys([s]);
    migrateLegacyStorageKeys([s]);
    assert.strictEqual(s.getItem("outpost_active_server"), "a");
    assert.strictEqual(s.length, 1);
});

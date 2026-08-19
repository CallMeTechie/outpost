import { test } from "node:test";
import assert from "node:assert/strict";
import { canSelfUpdate, packageHintKey } from "../updaterPolicy.js";

test("a package install can never self-update", () => {
    assert.equal(canSelfUpdate("deb"), false);
    assert.equal(canSelfUpdate("rpm"), false);
    assert.equal(canSelfUpdate("package"), false);
});

test("appimage and installer builds can self-update", () => {
    assert.equal(canSelfUpdate("appimage"), true);
    assert.equal(canSelfUpdate("installer"), true);
});

test("an unknown installation kind is treated as unable, not as able", () => {
    assert.equal(canSelfUpdate(undefined), false);
    assert.equal(canSelfUpdate(null), false);
    assert.equal(canSelfUpdate("something-new"), false);
});

test("deb and rpm each get their own package-manager hint", () => {
    assert.equal(packageHintKey("deb"), "updater.packageManagedDeb");
    assert.equal(packageHintKey("rpm"), "updater.packageManagedRpm");
});

test("an unknown package kind falls back to the generic hint", () => {
    assert.equal(packageHintKey("package"), "updater.packageManaged");
    assert.equal(packageHintKey("something-new"), "updater.packageManaged");
});

import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { emptyStateKey } from "../emptyState.js";

// The seam: emptyStateKey names a translation key, the locale files have to
// carry it. Nothing at runtime connects the two - i18next simply renders the
// raw key when it is missing, which looks like a typo in the UI rather than an
// error anywhere. Both sides are asserted here, not just the picking logic.

const LOCALES = ["en", "de_DE"];

const load = (name) => JSON.parse(
    readFileSync(new URL(`../../../../../../public/assets/locales/${name}.json`, import.meta.url), "utf8"),
);

const lookup = (dict, dottedKey) => dottedKey.split(".").reduce((at, part) => at?.[part], dict);

// Every state the picker can actually reach, and the key it asks for.
const STATES = [
    { available: true, reason: "no_server", sessions: [] },
    { available: true, sessions: [] },
    { available: false, reason: "not_installed", sessions: [] },
];

for (const locale of LOCALES) {
    for (const state of STATES) {
        const key = emptyStateKey(state);
        test(`${locale} carries the wording for ${key}`, () => {
            const text = lookup(load(locale), key);
            assert.strictEqual(typeof text, "string", `${key} is missing from ${locale}.json`);
            assert.ok(text.length > 0, `${key} is empty in ${locale}.json`);
        });
    }
}

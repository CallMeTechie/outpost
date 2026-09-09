import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../public/assets/locales/en.json";

// An instance of its own, never src/i18n.js: that module reads
// navigator.language while it loads (i18n.js:19) and installs the HTTP backend
// (:18), which fetches the translations over the network. Neither belongs in a
// test.
//
// The resources are handed in directly. With `resources` present i18next runs
// init synchronously, so useTranslation reports ready on the first render and no
// component suspends.
const testI18n = i18n.createInstance();

testI18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },

    // Two blind spots, closed the same way: a key that resolves to nothing and a
    // key that resolves to a subtree must both fail the test loudly.
    //
    // parseMissingKeyHandler alone is not enough. i18next only calls it once
    // resolution has fallen back to the key itself
    // (i18next/dist/cjs/i18next.js:724, condition `usedKey || usedDefault`). A key
    // pointing at an object turns back earlier (:612-620) and quietly yields
    // "key 'x (en)' returned an object instead of string." Every one of the 13
    // root keys in en.json is such an object.
    parseMissingKeyHandler: (key) => { throw new Error(`i18n: missing key "${key}"`); },
    returnedObjectHandler: (key) => { throw new Error(`i18n: key "${key}" is a subtree, not a string`); },
});

export default testI18n;

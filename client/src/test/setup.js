import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// @testing-library/react registers its own afterEach cleanup only when the test
// framework's hooks are globals. This project runs with globals: false, so the
// hook is registered here by hand - without it the DOM of one test leaks into
// the next one in the same file.
afterEach(cleanup);

// jsdom ships neither ResizeObserver nor scrollIntoView, and the code under test
// uses both. matchMedia it does ship, so that guard is normally a no-op; it stays
// so a jsdom without it would not break the layer.
//
// All three are installed once, centrally, so no suite reinvents them - and
// guarded, so a suite that wants its own stub can still install one.
//
// Written through globalThis and window, never through `global`:
// eslint.config.js:13 gives everything under src/ only globals.browser, and its
// node block (:74-81) matches files: ['*.js'], which reaches only files sitting
// directly in client/. `global.ResizeObserver = …` would be no-undef - an error,
// not a warning.
if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
}

if (typeof window.matchMedia === "undefined") {
    window.matchMedia = (query) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
    });
}

if (typeof Element.prototype.scrollIntoView === "undefined") {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
}

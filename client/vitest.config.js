import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

// The build config is the source of truth for the @ alias and the virtual
// guacamole module; rebuilding either here would be a second, drifting copy.
//
// This merge holds only while vite.config.js hands defineConfig an object
// literal. mergeConfig throws "Cannot merge config in form of callback" for a
// function config, so if vite.config.js ever becomes
// defineConfig(({ mode }) => …), this file has to call it first.
export default mergeConfig(viteConfig, defineConfig({
    test: {
        environment: "jsdom",
        // Deliberate, not just the default: eslint.config.js:13 gives everything
        // under src/ only globals.browser, so a global `test` or `expect` would
        // be no-undef - an error in this project, not a warning.
        globals: false,
        include: ["src/**/*.test.jsx"],
    },
}));

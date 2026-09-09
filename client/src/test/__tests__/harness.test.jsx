import { expect, test } from "vitest";
import { useToast } from "@/common/contexts/ToastContext.jsx";

// --- runner ---

test("the runner runs and the environment is a DOM", () => {
    // Two claims in one: vitest picked this file up through
    // include: ["src/**/*.test.jsx"], and vitest.config.js really put the suite
    // in jsdom rather than in plain node.
    expect(typeof document).toBe("object");
    expect(document.body).toBeTruthy();
});

test("the @ alias resolves, the way vitest.config.js's mergeConfig promises", () => {
    // The whole reason for a dedicated vitest.config.js is that it inherits the
    // alias from vite.config.js. Proving it here, with an import that needs
    // neither a render nor a provider, keeps an alias failure in the task that
    // caused it instead of surfacing four tasks later tangled up with real
    // component behaviour.
    expect(typeof useToast).toBe("function");
});

// --- setup ---

test("fills the gaps jsdom leaves that the codebase relies on", () => {
    // FavoritesBar and ViewContainer construct a ResizeObserver, UserSearch calls
    // scrollIntoView, and jsdom ships neither. A suite that had to stub them
    // itself would reinvent them once per file.
    expect(typeof globalThis.ResizeObserver).toBe("function");
    expect(typeof Element.prototype.scrollIntoView).toBe("function");

    const observer = new globalThis.ResizeObserver(() => {});
    expect(() => { observer.observe(document.body); observer.disconnect(); }).not.toThrow();

    // Called, not just counted: typeof also passes for a stub that is present but
    // does nothing, and jsdom ships no scrollIntoView at all - so this call runs
    // the one from setup.js and is evidence that the setup file was loaded.
    expect(() => document.body.scrollIntoView()).not.toThrow();

    // matchMedia is the odd one out - jsdom does implement it, so the guard in
    // setup.js is normally a no-op and this block is not evidence that setup.js
    // ran. It pins the shape the codebase reads, nothing more.
    const mq = window.matchMedia("(min-width: 700px)");
    expect(mq.matches).toBe(false);
    expect(() => mq.addEventListener("change", () => {})).not.toThrow();
});

test("jest-dom matchers are available on the imported expect", () => {
    // The /vitest entry point extends vitest's expect. It has to work with
    // globals: false, where `expect` is imported rather than global.
    //
    // Appended and removed rather than assigned through document.body.innerHTML:
    // this file grows across tasks 3 to 6, and a wholesale wipe of the body would
    // take an RTL container with it if a rendering case ever ends up above.
    const probe = document.createElement("div");
    probe.id = "probe";
    probe.textContent = "x";
    document.body.append(probe);
    expect(probe).toBeInTheDocument();
    probe.remove();
    expect(probe).not.toBeInTheDocument();
});

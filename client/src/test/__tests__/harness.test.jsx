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

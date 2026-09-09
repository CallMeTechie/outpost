import { expect, test } from "vitest";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import testI18n from "../i18n.js";
import { createContext, useContext } from "react";
import { screen } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { renderWithProviders } from "../renderWithProviders.jsx";
import { createRequestDouble } from "../requestDouble.js";

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

// --- i18n test instance ---

test("translates a real key from the shipped en.json", () => {
    // The real bundle, not a hand-kept test bundle: a missing key has to make the
    // test red, and a test bundle would switch exactly that check off.
    expect(testI18n.t("common.actions.cancel")).toBe("Cancel");
    expect(testI18n.t("settings.identities.dialog.messages.nameRequired"))
        .toBe("Identity name is required");
});

test("an invented key throws instead of rendering its own name", () => {
    expect(() => testI18n.t("common.actions.thisKeyDoesNotExist"))
        .toThrow(/missing key/);
});

test("a key that names a subtree throws as well", () => {
    // The likelier of the two mix-ups: shortening a key path lands on an
    // intermediate node. i18next answers that with a different placeholder
    // string, not with the missing-key path, so parseMissingKeyHandler alone
    // would let it pass.
    expect(() => testI18n.t("common")).toThrow(/subtree/);
});

// --- renderWithProviders ---

test("wraps in i18n without being asked, so t() yields text and not keys", () => {
    const Probe = () => {
        const { t } = useTranslation();
        return <span>{t("common.actions.cancel")}</span>;
    };

    renderWithProviders(<Probe />);
    expect(screen.getByText("Cancel")).toBeInTheDocument();
});

test("nests the named providers outermost first", () => {
    // The order matters and has to be observable, otherwise a later change could
    // reverse it without anything noticing.
    const Trace = createContext("");
    const Outer = ({ children }) => <Trace.Provider value="outer">{children}</Trace.Provider>;
    const Inner = ({ children }) => {
        const seen = useContext(Trace);
        return <Trace.Provider value={`${seen}>inner`}>{children}</Trace.Provider>;
    };
    const Probe = () => <span>{useContext(Trace)}</span>;

    renderWithProviders(<Probe />, { providers: [Outer, Inner] });
    expect(screen.getByText("outer>inner")).toBeInTheDocument();
});

// --- requestDouble ---

test("a request with no stubbed answer throws instead of resolving undefined", async () => {
    // A silent undefined would quietly send a test down the component's "the
    // server sent nothing" branch, and the test would look green while proving
    // the wrong thing.
    const double = createRequestDouble();
    const api = double.asModule();

    await expect(api.getRequest("identities")).rejects.toThrow(/no answer stubbed/);
});

test("a stubbed answer comes back and the call is recorded", async () => {
    const double = createRequestDouble();
    const api = double.asModule();
    double.stub("patchRequest", "identities/1", { id: 1, name: "renamed" });

    await expect(api.patchRequest("identities/1", { name: "renamed" }))
        .resolves.toEqual({ id: 1, name: "renamed" });
    expect(double.calls).toEqual([
        { method: "patchRequest", path: "identities/1", body: { name: "renamed" } },
    ]);
});

test("an Error as the stubbed answer is thrown, so failure paths can be driven", async () => {
    const double = createRequestDouble();
    const api = double.asModule();
    double.stub("postRequest", "identities", Object.assign(new Error("nope"), { code: 400 }));

    await expect(api.postRequest("identities", {})).rejects.toThrow("nope");
});

test("a path that names an Object.prototype member is still unstubbed", async () => {
    // Cannot fail while the store is a Map: Map.has does an exact lookup and never
    // walks a prototype chain, whatever the key looks like. The case stays as the
    // tripwire for anyone who later "simplifies" the store to an object literal -
    // ("__proto__" in {}) is true, and has() would start lying about paths nobody
    // stubbed. The composite key would mask that for these two paths, which is
    // exactly why the guarantee must not be pinned on it.
    const double = createRequestDouble();
    const api = double.asModule();

    await expect(api.getRequest("__proto__")).rejects.toThrow(/no answer stubbed/);
    await expect(api.getRequest("constructor")).rejects.toThrow(/no answer stubbed/);
});

test("reset clears both the answers and the recorded calls", async () => {
    const double = createRequestDouble();
    const api = double.asModule();
    double.stub("getRequest", "identities", []);
    await api.getRequest("identities");

    double.reset();
    expect(double.calls).toEqual([]);
    await expect(api.getRequest("identities")).rejects.toThrow(/no answer stubbed/);
});

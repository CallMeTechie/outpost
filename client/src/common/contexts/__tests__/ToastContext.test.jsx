import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEffect } from "react";
import { act, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "@/common/contexts/ToastContext.jsx";
import { renderWithProviders } from "@/test/renderWithProviders.jsx";

// A probe rather than a real consumer: this suite is about the context's timing,
// not about any component that happens to raise a toast.
//
// The value leaves the component from an effect, never by assignment during
// render: eslint.config.js turns the latter into an error, both for an outer
// variable ("Cannot reassign variables declared outside of the component/hook")
// and for a property write ("This value cannot be modified").
const ctx = {};
const Probe = () => {
    const value = useToast();
    useEffect(() => { ctx.current = value; });
    return null;
};

const mount = () => renderWithProviders(<Probe />, { providers: [ToastProvider] });

// Fake time only in this file, never in setup.js: the other two suites do not
// need it, and a globally stopped clock turns findBy* into a trap in every
// future suite.
//
// `ctx.current` is cleared as well - if mount() throws in one case, the stale
// context object from the previous case would otherwise drive the next one and
// produce a second, misleading failure.
beforeEach(() => { ctx.current = undefined; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// --- ToastContext ---

test("a toast appears, survives its own duration marked toast-exit, and is gone 300 ms later", () => {
    mount();

    act(() => { ctx.current.sendToast("Info", "saved", null, 5000); });
    expect(screen.getByText("saved")).toBeInTheDocument();

    // ToastContext.jsx:43 arms the alarm on `duration`, but removeToast (:24-29)
    // does not drop the node then - it marks it and defers the removal by another
    // 300 ms. Anything that asserts "gone after duration" would be wrong by
    // exactly that gap.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText("saved").closest(".toast")).toHaveClass("toast-exit");

    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByText("saved")).not.toBeInTheDocument();
});

test("removeToast takes a toast away on the same two-stage path", () => {
    mount();

    let id;
    // Infinity switches the automatic alarm off (ToastContext.jsx:42), so this
    // case observes removeToast alone rather than a race with the duration.
    act(() => { id = ctx.current.sendToast("Info", "manual", null, Infinity); });
    expect(screen.getByText("manual")).toBeInTheDocument();

    act(() => { ctx.current.removeToast(id); });
    expect(screen.getByText("manual").closest(".toast")).toHaveClass("toast-exit");

    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByText("manual")).not.toBeInTheDocument();
});

test("removing one of two standing toasts leaves the other one alone", () => {
    // Not started from the empty state on purpose: a suite that only ever holds
    // one toast cannot tell "removes the right one" from "removes them all".
    mount();

    let first;
    act(() => { first = ctx.current.sendToast("Info", "first", null, Infinity); });
    act(() => { ctx.current.sendToast("Info", "second", null, Infinity); });

    act(() => { ctx.current.removeToast(first); });
    act(() => { vi.advanceTimersByTime(300); });

    expect(screen.queryByText("first")).not.toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
});

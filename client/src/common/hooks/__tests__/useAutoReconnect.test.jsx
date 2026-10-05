import { afterEach, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAutoReconnect } from "../useAutoReconnect.js";

const activeSessions = [{ id: "s1", server: { type: "server", protocol: "ssh" } }];

const setup = (reconnectSession) => {
    const errors = new Map();
    const hook = renderHook(() => useAutoReconnect({
        activeSessions,
        reconnectSession,
        getSessionErrorInfo: (id) => errors.get(id) || null,
        enabled: true,
        serverConnected: true,
    }));
    return { hook, errors };
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

test("wartet 5, 10, 30 s zwischen den Versuchen und setzt den Zähler erst nach 10 s Stabilität zurück", async () => {
    vi.useFakeTimers({ now: 0 });
    const reconnectSession = vi.fn().mockResolvedValue({ connected: false });
    const { hook, errors } = setup(reconnectSession);

    act(() => hook.result.current.markSessionConnected("s1"));
    errors.set("s1", { retryable: true });
    act(() => hook.result.current.handleSessionErrored("s1"));
    expect(hook.result.current.reconnectStates.s1).toEqual({ attempt: 1, maxAttempts: 5, nextAttemptAt: 5000 });

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(reconnectSession).toHaveBeenCalledTimes(1);
    expect(hook.result.current.reconnectStates.s1).toEqual({ attempt: 2, maxAttempts: 5, nextAttemptAt: 15000 });

    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(reconnectSession).toHaveBeenCalledTimes(2);
    expect(hook.result.current.reconnectStates.s1).toEqual({ attempt: 3, maxAttempts: 5, nextAttemptAt: 45000 });

    act(() => hook.result.current.markSessionConnected("s1"));
    await act(() => vi.advanceTimersByTimeAsync(9000));
    act(() => hook.result.current.handleSessionErrored("s1"));
    expect(hook.result.current.reconnectStates.s1.attempt).toBe(3);

    act(() => hook.result.current.markSessionConnected("s1"));
    await act(() => vi.advanceTimersByTimeAsync(10000));
    act(() => hook.result.current.handleSessionErrored("s1"));
    expect(hook.result.current.reconnectStates.s1).toEqual({ attempt: 1, maxAttempts: 5, nextAttemptAt: Date.now() + 5000 });
});

test("wird der Tab wieder sichtbar, versucht er es sofort statt den Countdown abzuwarten", async () => {
    vi.useFakeTimers({ now: 0 });
    const reconnectSession = vi.fn().mockResolvedValue({ connected: true });
    const { hook, errors } = setup(reconnectSession);

    act(() => hook.result.current.markSessionConnected("s1"));
    errors.set("s1", { retryable: true });
    act(() => hook.result.current.handleSessionErrored("s1"));

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });

    expect(reconnectSession).toHaveBeenCalledWith("s1");
    expect(hook.result.current.reconnectStates.s1).toBeUndefined();
});

test("scheitert schon die Erstverbindung, plant die Automatik nichts, der Knopf geht trotzdem", async () => {
    vi.useFakeTimers({ now: 0 });
    const reconnectSession = vi.fn().mockResolvedValue({ connected: false });
    const { hook, errors } = setup(reconnectSession);

    errors.set("s1", { retryable: true });
    act(() => hook.result.current.handleSessionErrored("s1"));
    expect(hook.result.current.reconnectStates.s1).toBeUndefined();

    await act(() => vi.advanceTimersByTimeAsync(130000));
    expect(reconnectSession).not.toHaveBeenCalled();

    await act(() => hook.result.current.reconnectNow("s1"));
    expect(reconnectSession).toHaveBeenCalledTimes(1);
});

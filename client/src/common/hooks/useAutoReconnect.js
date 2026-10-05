import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldAttemptAutoReconnect } from "@/common/utils/ReconnectPolicy.js";

const BACKOFFS = [5, 10, 30, 60, 120];
const MAX_ATTEMPTS = BACKOFFS.length;
const RECONNECT_COOLDOWN_MS = 3000;
const STABLE_CONNECTION_MS = 10000;

const clearTimerOf = (timers, id) => {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
};

export const useAutoReconnect = ({ activeSessions, reconnectSession, getSessionErrorInfo, enabled, serverConnected }) => {
    const [reconnectStates, setReconnectStates] = useState({});
    const [prevEnabled, setPrevEnabled] = useState(enabled);
    if (prevEnabled !== enabled) {
        setPrevEnabled(enabled);
        if (!enabled) setReconnectStates({});
    }

    const connectedById = useRef(new Map());
    const attemptsById = useRef(new Map());
    const timersById = useRef(new Map());
    const stableTimersById = useRef(new Map());
    const lastAttemptById = useRef(new Map());
    const inFlightById = useRef(new Map());
    const scheduleRef = useRef(null);
    const unmountedRef = useRef(false);

    const latest = useRef({ activeSessions, enabled, reconnectSession, getSessionErrorInfo });
    useEffect(() => {
        latest.current = { activeSessions, enabled, reconnectSession, getSessionErrorInfo };
    });

    const mayAttempt = useCallback((id) => {
        const current = latest.current;
        return shouldAttemptAutoReconnect({
            enabled: current.enabled,
            session: current.activeSessions.find(s => s.id === id) || null,
            errorInfo: current.getSessionErrorInfo?.(id) || null,
            wasConnected: connectedById.current.get(id),
        });
    }, []);

    const clearState = useCallback((id) => {
        setReconnectStates(prev => {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
        });
    }, []);

    const inCooldown = useCallback((id) => Date.now() - (lastAttemptById.current.get(id) ?? -Infinity) < RECONNECT_COOLDOWN_MS, []);

    const attempt = useCallback((id, { bypassCooldown = false } = {}) => {
        const running = inFlightById.current.get(id);
        if (running) return running;
        if (!bypassCooldown && inCooldown(id)) return Promise.resolve(null);
        lastAttemptById.current.set(id, Date.now());
        const run = Promise.resolve(latest.current.reconnectSession?.(id))
            .then(result => result?.connected === true)
            .catch(() => false)
            .finally(() => inFlightById.current.delete(id));
        inFlightById.current.set(id, run);
        return run;
    }, [inCooldown]);

    const scheduleAfterFailure = useCallback((id, connected) => {
        if (connected === false && !unmountedRef.current) scheduleRef.current?.(id);
    }, []);

    const schedule = useCallback((id) => {
        if (unmountedRef.current || timersById.current.has(id)) return;
        const attempts = attemptsById.current.get(id) || 0;
        if (!mayAttempt(id) || attempts >= MAX_ATTEMPTS) {
            clearState(id);
            return;
        }
        const delay = BACKOFFS[attempts] * 1000;
        setReconnectStates(prev => ({ ...prev, [id]: { attempt: attempts + 1, maxAttempts: MAX_ATTEMPTS, nextAttemptAt: Date.now() + delay } }));
        timersById.current.set(id, setTimeout(async () => {
            timersById.current.delete(id);
            attemptsById.current.set(id, attempts + 1);
            if (!mayAttempt(id)) {
                clearState(id);
                return;
            }
            const connected = await attempt(id);
            if (unmountedRef.current) return;
            if (connected === true) clearState(id);
            else scheduleRef.current?.(id);
        }, delay));
    }, [mayAttempt, attempt, clearState]);

    useEffect(() => {
        scheduleRef.current = schedule;
    }, [schedule]);

    const markSessionConnected = useCallback((id) => {
        connectedById.current.set(id, true);
        clearTimerOf(timersById.current, id);
        clearState(id);
        clearTimerOf(stableTimersById.current, id);
        stableTimersById.current.set(id, setTimeout(() => {
            attemptsById.current.set(id, 0);
            stableTimersById.current.delete(id);
        }, STABLE_CONNECTION_MS));
    }, [clearState]);

    const handleSessionErrored = useCallback((id) => {
        if (!mayAttempt(id)) return;
        clearTimerOf(stableTimersById.current, id);
        schedule(id);
    }, [mayAttempt, schedule]);

    const reconnectNow = useCallback((id) => {
        clearTimerOf(timersById.current, id);
        clearState(id);
        attemptsById.current.set(id, 0);
        const run = attempt(id, { bypassCooldown: true });
        run.then(connected => scheduleAfterFailure(id, connected));
        return run;
    }, [clearState, attempt, scheduleAfterFailure]);

    const retryReachable = useCallback(() => {
        for (const session of latest.current.activeSessions) {
            const id = session.id;
            if (inFlightById.current.has(id) || !mayAttempt(id)) continue;
            const attempts = attemptsById.current.get(id) || 0;
            if (attempts >= MAX_ATTEMPTS || inCooldown(id)) continue;
            clearTimerOf(timersById.current, id);
            clearState(id);
            attemptsById.current.set(id, attempts + 1);
            void attempt(id).then(connected => scheduleAfterFailure(id, connected));
        }
    }, [mayAttempt, inCooldown, attempt, clearState, scheduleAfterFailure]);

    const wasServerConnected = useRef(serverConnected);
    useEffect(() => {
        const was = wasServerConnected.current;
        wasServerConnected.current = serverConnected;
        if (!was && serverConnected) retryReachable();
    }, [serverConnected, retryReachable]);

    useEffect(() => {
        const onVisible = () => { if (document.visibilityState === "visible") retryReachable(); };
        window.addEventListener("online", retryReachable);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            window.removeEventListener("online", retryReachable);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [retryReachable]);

    useEffect(() => {
        if (enabled) return;
        const timers = timersById.current;
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
    }, [enabled]);

    const liveIds = useMemo(() => new Set(activeSessions.map(s => s.id)), [activeSessions]);

    useEffect(() => {
        for (const timers of [timersById.current, stableTimersById.current]) {
            for (const id of [...timers.keys()]) if (!liveIds.has(id)) clearTimerOf(timers, id);
        }
        for (const map of [connectedById.current, attemptsById.current, lastAttemptById.current, inFlightById.current]) {
            for (const id of [...map.keys()]) if (!liveIds.has(id)) map.delete(id);
        }
    }, [liveIds]);

    useEffect(() => {
        const timers = timersById.current;
        const stableTimers = stableTimersById.current;
        unmountedRef.current = false;
        return () => {
            unmountedRef.current = true;
            for (const map of [timers, stableTimers]) {
                for (const timer of map.values()) clearTimeout(timer);
                map.clear();
            }
        };
    }, []);

    return useMemo(() => ({
        reconnectStates: enabled ? Object.fromEntries(Object.entries(reconnectStates).filter(([id]) => liveIds.has(id))) : {},
        markSessionConnected,
        handleSessionErrored,
        reconnectNow,
    }), [enabled, reconnectStates, liveIds, markSessionConnected, handleSessionErrored, reconnectNow]);
};

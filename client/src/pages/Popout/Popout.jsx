import "./styles.sass";
import { useEffect, useState, useRef, useContext, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { getRequest, deleteRequest } from "@/common/utils/RequestUtil";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { isReconnectEligible, requestReconnect, applyReconnectOutcome } from "@/common/utils/ReconnectPolicy.js";
import { shouldRecordError } from "@/pages/Servers/utils/sessionErrors.js";
import GuacamoleRenderer from "@/pages/Servers/components/ViewContainer/renderer/GuacamoleRenderer.jsx";
import XtermRenderer from "@/pages/Servers/components/ViewContainer/renderer/XtermRenderer.jsx";
import ConnectionError from "@/pages/Servers/components/ViewContainer/renderer/components/ConnectionError";
import Loading from "@/common/components/Loading";
import TitleBar from "@/common/components/TitleBar";
import { isTauri } from "@/common/utils/TauriUtil.js";
import { notifyPopoutClosed, onForceClose } from "@/common/utils/PopoutUtil.js";

const noop = () => {};

export const Popout = () => {
    const { sessionId, monitor } = useParams();
    const { t } = useTranslation();
    const { user } = useContext(UserContext);
    const { sendToast } = useToast();
    const [session, setSession] = useState(null);
    const [loading, setLoading] = useState(true);
    const [connection, setConnection] = useState({ error: null, generation: 1, attachNonce: 0 });
    const [reconnecting, setReconnecting] = useState(false);
    const refs = useRef({});
    const isConnectorMode = isTauri();

    const parsedMonitor = Number.parseInt(monitor, 10);
    const pinnedMonitor = Number.isInteger(parsedMonitor) && parsedMonitor >= 0 ? parsedMonitor : null;

    const titleOf = (name) => pinnedMonitor === null
        ? name : `${name} - ${t("servers.monitors.title", { number: pinnedMonitor + 1 })}`;

    const takeGeneration = useCallback((generation) => {
        setConnection(prev => (generation > prev.generation ? { ...prev, generation } : prev));
    }, []);

    useEffect(() => {
        if (!sessionId || !user) return;
        let ignore = false;
        getRequest(`/connections/${sessionId}`)
            .then(data => {
                if (ignore) return;
                setSession(data);
                takeGeneration(data.generation ?? 1);
                if (data.server?.name) document.title = `${titleOf(data.server.name)} - Outpost`;
            })
            .finally(() => { if (!ignore) setLoading(false); });
        return () => { ignore = true; };
    }, [sessionId, user, pinnedMonitor, takeGeneration]);

    useEffect(() => {
        if (isConnectorMode) return;
        const cleanup = () => notifyPopoutClosed(sessionId, pinnedMonitor);
        window.addEventListener("beforeunload", cleanup);
        return () => window.removeEventListener("beforeunload", cleanup);
    }, [sessionId, isConnectorMode, pinnedMonitor]);

    useEffect(() => onForceClose(() => window.close()), []);

    const markSessionErrored = useCallback((_id, error) => {
        setConnection(prev => (shouldRecordError(prev.error, error, prev.generation) ? { ...prev, error } : prev));
    }, []);

    const reconnect = async () => {
        setReconnecting(true);
        try {
            const result = await requestReconnect(sessionId, t);
            await applyReconnectOutcome(result, {
                onReconnected: (generation) => setConnection(prev => ({ ...prev, error: null, generation: Math.max(prev.generation, generation) })),
                onReattach: async () => {
                    const data = await getRequest(`/connections/${sessionId}`).catch(() => null);
                    setConnection(prev => ({
                        ...prev, error: null, attachNonce: prev.attachNonce + 1,
                        generation: Math.max(prev.generation, data?.generation ?? 1),
                    }));
                },
                onEnded: () => window.close(),
                onRefused: (error) => setConnection(prev => ({ ...prev, error: { ...error, generation: prev.generation } })),
                onFailed: () => sendToast("Error", t("common.errors.connection.reconnectFailed")),
            });
        } finally {
            setReconnecting(false);
        }
    };

    const closeSession = () => {
        deleteRequest(`/connections/${sessionId}`)
            .catch(error => console.debug("Session deletion request failed:", error))
            .finally(() => window.close());
    };

    if (loading) return <Loading />;
    if (!session || session.error) return null;

    const renderer = session.type || session.server?.renderer;
    const closeWindow = () => window.close();
    const fullscreen = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    const liveSession = { ...session, generation: connection.generation };
    const rendererKey = `${session.id}-${connection.generation}-${connection.attachNonce}`;
    const getSessionError = () => connection.error?.message ?? null;

    return (
        <div className="popout-container">
            {isConnectorMode && <TitleBar title={titleOf(session.server?.name || "Session")} />}
            {renderer === "guac" && <GuacamoleRenderer key={rendererKey} session={liveSession} disconnectFromServer={closeWindow}
                                                      markSessionErrored={markSessionErrored} getSessionError={getSessionError}
                                                      registerGuacamoleRef={noop} onFullscreenToggle={fullscreen}
                                                      pinnedMonitor={pinnedMonitor} />}
            {renderer === "terminal" && <XtermRenderer key={rendererKey} session={liveSession} disconnectFromServer={closeWindow}
                                                       markSessionErrored={markSessionErrored} getSessionError={getSessionError}
                                                       registerTerminalRef={noop} broadcastMode={false} terminalRefs={refs}
                                                       updateProgress={noop} layoutMode="single" onBroadcastToggle={noop}
                                                       onFullscreenToggle={fullscreen} />}
            {connection.error && (
                <ConnectionError message={connection.error.message} retryable={connection.error.retryable}
                                 expired={connection.error.expired} reconnecting={reconnecting}
                                 reconnectable={connection.error.reconnectable}
                                 onReconnect={isReconnectEligible(session) ? reconnect : undefined}
                                 onClose={closeSession} />
            )}
        </div>
    );
};

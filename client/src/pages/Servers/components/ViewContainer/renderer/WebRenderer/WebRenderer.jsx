import "./styles.sass";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { useKeymaps, matchesKeybind } from "@/common/contexts/KeymapContext.jsx";
import { getWebSocketUrl } from "@/common/utils/ConnectionUtil.js";
import Button from "@/common/components/Button";
import AddressBar from "./AddressBar.jsx";
import { decodeFrame, isNewerSeq } from "./frameProtocol.js";
import { IME_FILLER, createMoveThrottle, fitFrame, imePayloads, keyPayload, mousePayload, pastePayload, resizePayload, touchScrollPayload, wheelPayload } from "./inputPayload.js";

const RESIZE_DEBOUNCE_MS = 150;
const RECONNECT_MAX_MS = 15000;
const TAP_SLOP_PX = 8;
const INITIAL_PAGE = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false };

const PageDialog = ({ dialog, onReply }) => {
    const { t } = useTranslation();
    const [text, setText] = useState(dialog.defaultPrompt ?? "");
    return (
        <div className="web-dialog" role="alertdialog" aria-label={dialog.kind}>
            {dialog.origin && <p className="web-dialog-origin">{t("servers.webRenderer.dialogFrom", { origin: dialog.origin })}</p>}
            <p>{dialog.message}</p>
            {dialog.kind === "prompt" && <input value={text} onChange={(e) => setText(e.target.value)} autoFocus />}
            <div className="web-dialog-actions">
                {dialog.kind !== "alert" && <Button type="secondary" text={t("common.cancel")} onClick={() => onReply(false)} />}
                <Button type="primary" text={t("servers.webRenderer.dialogAccept")} onClick={() => onReply(true, dialog.kind === "prompt" ? text : undefined)} />
            </div>
        </div>
    );
};

const WebRenderer = ({ session, markSessionErrored, isVisible = true }) => {
    const { t } = useTranslation();
    const { sessionToken } = useContext(UserContext);
    const { keymaps, getParsedKeybind } = useKeymaps();
    const wsRef = useRef(null);
    const stageRef = useRef(null);
    const canvasRef = useRef(null);
    const imeRef = useRef(null);
    const touchRef = useRef(null);
    const viewportRef = useRef({ width: 1280, height: 800 });
    const drawnSeqRef = useRef(null);
    const decodingRef = useRef(false);
    const pendingFrameRef = useRef(null);
    const [moveAllowed] = useState(createMoveThrottle);
    const [page, setPage] = useState(INITIAL_PAGE);
    const [agent, setAgent] = useState({ active: false, tool: null, paused: false });
    const [dialog, setDialog] = useState(null);
    const [notice, setNotice] = useState(null);
    const [connected, setConnected] = useState(false);

    const sendJson = useCallback((message) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    }, []);

    const drawFrame = useCallback(async (buffer) => {
        const frame = decodeFrame(buffer);
        if (!frame || !isNewerSeq(frame.seq, drawnSeqRef.current)) return;
        const bitmap = await createImageBitmap(new Blob([frame.data], { type: "image/jpeg" }));
        const canvas = canvasRef.current;
        // A newer frame may have been drawn while this one decoded; only ever the newest is shown.
        if (!canvas || !isNewerSeq(frame.seq, drawnSeqRef.current)) {
            bitmap.close();
            return;
        }
        drawnSeqRef.current = frame.seq;
        viewportRef.current = { width: bitmap.width, height: bitmap.height };
        const rect = canvas.getBoundingClientRect();
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const { scale, offsetX, offsetY } = fitFrame({ width, height }, viewportRef.current);
        const context = canvas.getContext("2d");
        context.clearRect(0, 0, width, height);
        context.drawImage(bitmap, offsetX, offsetY, bitmap.width * scale, bitmap.height * scale);
        bitmap.close();
    }, []);

    const pushFrame = useCallback(async (buffer) => {
        pendingFrameRef.current = buffer;
        if (decodingRef.current) return;
        decodingRef.current = true;
        try {
            while (pendingFrameRef.current) {
                const next = pendingFrameRef.current;
                pendingFrameRef.current = null;
                try {
                    await drawFrame(next);
                } catch {
                    // A frame that cannot be decoded is dropped; the next one replaces it anyway.
                }
            }
        } finally {
            decodingRef.current = false;
        }
    }, [drawFrame]);

    // A hidden pane stays mounted, so it must not stay a viewer: it would keep streaming, keep the
    // session from idling out, and - as the first viewer - keep the viewport authority.
    useEffect(() => {
        if (!sessionToken || !isVisible) return;
        let disposed = false;
        let retryTimer = null;
        let attempt = 0;
        const connect = () => {
            const ws = new WebSocket(getWebSocketUrl("/api/ws/browser", { sessionToken, browserSessionId: session.id }));
            ws.binaryType = "arraybuffer";
            wsRef.current = ws;
            ws.onopen = () => setConnected(true);
            ws.onmessage = (event) => {
                if (typeof event.data !== "string") {
                    pushFrame(event.data);
                    return;
                }
                let message;
                try {
                    message = JSON.parse(event.data);
                } catch {
                    return;
                }
                switch (message.type) {
                    case "ready": {
                        attempt = 0;
                        // A dialog closed while the connection was down sends no dialogClosed; the server repeats an open one after ready.
                        setDialog(null);
                        viewportRef.current = message.viewport;
                        // Sent on "ready", not on open: the server listens only once the token is checked.
                        const rect = stageRef.current?.getBoundingClientRect();
                        if (rect?.width > 0 && rect?.height > 0) ws.send(JSON.stringify(resizePayload(rect)));
                        break;
                    }
                    case "state":
                        setPage({ url: message.url, title: message.title, loading: message.loading, canGoBack: message.canGoBack, canGoForward: message.canGoForward });
                        break;
                    case "agent":
                        setAgent({ active: message.active, tool: message.tool, paused: message.paused });
                        break;
                    case "dialog":
                        setDialog({ id: message.id, kind: message.kind, message: message.message, defaultPrompt: message.defaultPrompt, origin: message.origin });
                        break;
                    case "focus": {
                        // Set on the element, not through state: the keyboard follows inputmode only while the field keeps focus.
                        const ime = imeRef.current;
                        if (ime && document.activeElement === ime) ime.inputMode = message.editable ? "text" : "none";
                        break;
                    }
                    case "dialogClosed":
                        setDialog(null);
                        break;
                    case "download":
                        setNotice(t("servers.webRenderer.download", { filename: message.filename, state: message.state }));
                        break;
                    case "error":
                        setNotice(message.message);
                        break;
                    case "closed":
                        setNotice(t("servers.webRenderer.closed", { reason: message.reason }));
                        break;
                }
            };
            ws.onclose = (event) => {
                if (wsRef.current === ws) wsRef.current = null;
                setConnected(false);
                if (disposed) return;
                if (event.code >= 4000) {
                    markSessionErrored?.(session.id, event.reason || "Browser session unavailable");
                    return;
                }
                // 1000 means the session ended; the state stream removes the tab.
                if (event.code === 1000) return;
                retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, RECONNECT_MAX_MS));
            };
        };
        connect();
        return () => {
            disposed = true;
            clearTimeout(retryTimer);
            const ws = wsRef.current;
            wsRef.current = null;
            pendingFrameRef.current = null;
            ws?.close(1000);
        };
    }, [session.id, sessionToken, isVisible, pushFrame, markSessionErrored, t]);

    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        let timer = null;
        const observer = new ResizeObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const rect = stage.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) sendJson(resizePayload(rect));
            }, RESIZE_DEBOUNCE_MS);
        });
        observer.observe(stage);
        // React's onWheel is passive; preventing the outer scroll needs a native listener.
        const onWheel = (e) => {
            e.preventDefault();
            const canvas = canvasRef.current;
            if (canvas) sendJson(wheelPayload(e, canvas.getBoundingClientRect(), viewportRef.current));
        };
        stage.addEventListener("wheel", onWheel, { passive: false });
        return () => {
            clearTimeout(timer);
            observer.disconnect();
            stage.removeEventListener("wheel", onWheel);
        };
    }, [sendJson]);

    const onPointer = (action, e) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (action === "move" && !moveAllowed()) return;
        const touch = touchRef.current !== null;
        // A tap gets the hidden field instead of the stage: only a focused text field can show the soft keyboard.
        if (action === "down") (touch ? imeRef.current : stageRef.current)?.focus({ preventScroll: true });
        const payload = mousePayload(action, e, canvas.getBoundingClientRect(), viewportRef.current);
        sendJson(action === "up" && touch ? { ...payload, focusCheck: true } : payload);
    };

    // Taps arrive as the mouse events the browser derives from them; only a drag is handled here.
    const onTouch = (action, e) => {
        if (e.pointerType !== "touch") {
            if (action === "down") touchRef.current = null;
            return;
        }
        if (action === "down") {
            touchRef.current = { startX: e.clientX, startY: e.clientY, last: { clientX: e.clientX, clientY: e.clientY }, dragging: false };
            return;
        }
        const touch = touchRef.current;
        const canvas = canvasRef.current;
        if (action !== "move" || !touch || !canvas) return;
        touch.dragging ||= Math.hypot(e.clientX - touch.startX, e.clientY - touch.startY) > TAP_SLOP_PX;
        if (!touch.dragging) return;
        const point = { clientX: e.clientX, clientY: e.clientY };
        sendJson(touchScrollPayload(touch.last, point, canvas.getBoundingClientRect(), viewportRef.current));
        touch.last = point;
    };

    const resetIme = () => {
        const ime = imeRef.current;
        if (!ime) return;
        ime.value = IME_FILLER;
        ime.setSelectionRange(IME_FILLER.length, IME_FILLER.length);
    };

    const flushIme = () => {
        const ime = imeRef.current;
        if (!ime) return;
        for (const payload of imePayloads(ime.value)) sendJson(payload);
        resetIme();
    };

    // Soft keyboards report most keys as "Unidentified" (229) and deliver the text through input events.
    const onImeKey = (action, e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key === "Unidentified") return;
        onKey(action, e);
    };

    const toggleKeyboard = () => {
        const ime = imeRef.current;
        if (!ime) return;
        if (document.activeElement === ime && ime.inputMode === "text") return ime.blur();
        ime.inputMode = "text";
        ime.focus({ preventScroll: true });
    };

    const onKey = (action, e) => {
        // Ctrl+V stays with the browser so it fires "paste" with the local clipboard; the container's is empty.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
        if (keymaps.some((keymap) => keymap.enabled && matchesKeybind(e, getParsedKeybind(keymap.action)))) return;
        e.preventDefault();
        e.stopPropagation();
        sendJson(keyPayload(action, e.nativeEvent));
    };

    const onPaste = (e) => {
        const text = e.clipboardData?.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        sendJson(pastePayload(text));
    };

    const replyToDialog = (accept, promptText) => {
        sendJson({ type: "dialogReply", id: dialog.id, accept, promptText });
        setDialog(null);
    };

    return (
        <div className="web-renderer">
            {/* The stage comes first in the DOM although it is drawn below the address bar:
                ViewContainer focuses the first focusable element of a pane, and that has to be
                the page, not the address field. */}
            <div className="web-stage" ref={stageRef} tabIndex={0}
                 onPointerDown={(e) => onTouch("down", e)} onPointerMove={(e) => onTouch("move", e)}
                 onMouseMove={(e) => onPointer("move", e)} onMouseDown={(e) => onPointer("down", e)}
                 onMouseUp={(e) => onPointer("up", e)} onKeyDown={(e) => onKey("down", e)}
                 onKeyUp={(e) => onKey("up", e)} onPaste={onPaste} onContextMenu={(e) => e.preventDefault()}>
                <canvas ref={canvasRef} />
                {!connected && <div className="web-connecting">{t("servers.webRenderer.connecting")}</div>}
            </div>
            <textarea className="web-ime" ref={imeRef} inputMode="none" tabIndex={-1} aria-hidden="true"
                      autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                      onFocus={resetIme} onInput={(e) => { if (!e.nativeEvent.isComposing) flushIme(); }}
                      onCompositionEnd={flushIme} onKeyDown={(e) => onImeKey("down", e)}
                      onKeyUp={(e) => onImeKey("up", e)} onPaste={onPaste} />
            <AddressBar page={page} agent={agent} connected={connected} onKeyboard={toggleKeyboard}
                        onNavigate={(url) => sendJson({ type: "navigate", url })}
                        onHistory={(action) => sendJson({ type: "nav", action })}
                        onPause={(paused) => sendJson({ type: "pause", paused })}
                        onClose={() => sendJson({ type: "close" })} />
            {notice && <div className="web-notice" role="status" onClick={() => setNotice(null)}>{notice}</div>}
            {dialog && <PageDialog dialog={dialog} onReply={replyToDialog} />}
        </div>
    );
};

export default WebRenderer;

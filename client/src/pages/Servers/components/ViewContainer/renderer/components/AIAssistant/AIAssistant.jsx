import { memo, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import { BotMessageSquare as IconBotMessageSquare, Send as IconSend, Square as IconSquare, X as IconX, Check as IconCheck, Ban as IconBan, Terminal as IconTerminal, FileText as IconFileText, FilePen as IconFilePen, Folder as IconFolder, Info as IconInfo, FolderPlus as IconFolderPlus, Trash as IconTrash, Scissors as IconScissors, Lock as IconLock, Search as IconSearch, Play as IconPlay, ChevronDown as IconChevronDown, ChevronUp as IconChevronUp } from "lucide-react";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { useKeymaps, matchesKeybind } from "@/common/contexts/KeymapContext.jsx";
import Button from "@/common/components/Button";
import FloatingWindow from "@/common/components/FloatingWindow";
import { getWebSocketUrl } from "@/common/utils/ConnectionUtil.js";
import MessageContent from "./components/MessageContent";
import "./styles.sass";

const TOOL_META = {
    runCommand: { icon: IconTerminal, summary: (a) => a.command },
    readFile: { icon: IconFileText, summary: (a) => a.path },
    writeFile: { icon: IconFilePen, summary: (a) => a.path },
    editFile: { icon: IconFilePen, summary: (a) => a.path },
    listDirectory: { icon: IconFolder, summary: (a) => a.path },
    statPath: { icon: IconInfo, summary: (a) => a.path },
    makeDirectory: { icon: IconFolderPlus, summary: (a) => a.path },
    deleteFile: { icon: IconTrash, summary: (a) => a.path },
    removeDirectory: { icon: IconTrash, summary: (a) => (a.recursive ? `${a.path} (recursive)` : a.path) },
    movePath: { icon: IconScissors, summary: (a) => `${a.source} → ${a.destination}` },
    changePermissions: { icon: IconLock, summary: (a) => `${a.path} → ${a.mode}` },
    findDirectories: { icon: IconSearch, summary: (a) => a.query },
};

const newConversationId = () => globalThis.crypto?.randomUUID?.()
    ?? `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const ToolResult = ({ tool, result }) => {
    if (!result || result.denied) return null;

    if (tool === "runCommand") {
        return (
            <div className="tool-result">
                {result.stdout ? <pre className="output">{result.stdout}</pre> : null}
                {result.stderr ? <pre className="output stderr">{result.stderr}</pre> : null}
            </div>
        );
    }

    if (tool === "readFile") {
        return (
            <div className="tool-result">
                <pre className="output">{result.content}{result.truncated ? "\n… [truncated]" : ""}</pre>
            </div>
        );
    }

    if (tool === "listDirectory") {
        return (
            <div className="tool-result dir-list">
                {(result.entries || []).map((e, i) => (
                    <span key={`${e.name}-${i}`} className={`dir-entry ${e.type}`}>{e.name}{e.type === "folder" ? "/" : ""}</span>
                ))}
            </div>
        );
    }

    return (
        <div className="tool-result">
            <pre className="output">{JSON.stringify(result, null, 2)}</pre>
        </div>
    );
};

const ToolCard = memo(({ message, onConfirm, acceptHint }) => {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const meta = TOOL_META[message.tool] || { icon: IconTerminal, summary: () => "" };
    const summary = meta.summary(message.args || {});
    const exitCode = message.tool === "runCommand" && message.status === "done" && message.result && !message.result.denied
        ? message.result.exitCode : null;
    const failed = exitCode !== null && exitCode !== 0;

    const settled = message.status !== "running" && message.status !== "awaiting-confirm";
    const open = !settled || expanded;
    const toggle = () => settled && setExpanded((prev) => !prev);

    return (
        <div className={`tool-card status-${message.status}${failed ? " exit-failed" : ""}${settled ? " settled" : ""}`}>
            <div className="tool-head" onClick={toggle} role={settled ? "button" : undefined}
                 tabIndex={settled ? 0 : undefined} aria-expanded={settled ? open : undefined}
                 onKeyDown={(e) => { if (settled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } }}>
                <Icon icon={meta.icon} />
                <span className="tool-name">{t(`servers.aiAssistant.tools.${message.tool}`)}</span>
                {!open && summary && <span className="tool-summary">{summary}</span>}
                <span className="tool-status">
                    {message.status === "running" && <span className="ai-spinner" />}
                    {message.status === "done" && (failed
                        ? <span className="tool-exit fail">exit {exitCode}</span>
                        : <Icon icon={IconCheck} />)}
                    {message.status === "denied" && <Icon icon={IconBan} />}
                    {message.status === "aborted" && <Icon icon={IconSquare} />}
                    {message.status === "error" && <Icon icon={IconX} />}
                </span>
                {settled && <Icon className="tool-chevron" icon={open ? IconChevronUp : IconChevronDown} />}
            </div>

            {open && summary && <div className="tool-target">{summary}</div>}

            {message.status === "awaiting-confirm" && (
                <div className="tool-confirm">
                    <span>{t("servers.aiAssistant.confirmPrompt")}</span>
                    <div className="confirm-actions">
                        <Button type="danger" icon={IconBan} text={t("servers.aiAssistant.deny")}
                                onClick={() => onConfirm(message.callId, false)} />
                        <Button icon={IconCheck} text={t("servers.aiAssistant.allow")}
                                title={acceptHint ? t("servers.aiAssistant.allowShortcut", { key: acceptHint }) : undefined}
                                onClick={() => onConfirm(message.callId, true)} />
                    </div>
                    {acceptHint && <span className="confirm-hint">{t("servers.aiAssistant.allowShortcut", { key: acceptHint })}</span>}
                </div>
            )}

            {open && message.status === "denied" && <div className="tool-note">{t("servers.aiAssistant.denied")}</div>}
            {open && message.status === "aborted" && <div className="tool-note">{t("servers.aiAssistant.stopped")}</div>}
            {open && message.status === "error" && <div className="tool-note error">{message.error}</div>}
            {open && message.status === "done" && <ToolResult tool={message.tool} result={message.result} />}
        </div>
    );
});

export const AIAssistant = ({ session, onClose }) => {
    const { t } = useTranslation();
    const { sessionToken } = useContext(UserContext);
    const { getParsedKeybind, getKeybind, formatKey } = useKeymaps();
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [running, setRunning] = useState(false);
    const [ready, setReady] = useState(false);
    const [needsContinue, setNeedsContinue] = useState(false);
    const [connectionError, setConnectionError] = useState(null);
    const wsRef = useRef(null);
    const messagesRef = useRef(null);
    const inputRef = useRef(null);

    const appendAssistant = (delta) => {
        setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant" && last.streaming) {
                return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
            }
            return [...prev, { role: "assistant", text: delta, streaming: true }];
        });
    };

    const upsertTool = useCallback((callId, patch, base) => {
        setMessages((prev) => {
            const idx = prev.findIndex((m) => m.role === "tool" && m.callId === callId);
            if (idx === -1) {
                if (!base) return prev;
                return [...prev, { role: "tool", callId, ...base, ...patch }];
            }
            const next = [...prev];
            next[idx] = { ...next[idx], ...patch };
            return next;
        });
    }, []);

    const stopStreaming = () => {
        setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "assistant" && last.streaming) {
                return [...prev.slice(0, -1), { ...last, streaming: false }];
            }
            return prev;
        });
    };

    const finalizeRunningTools = () => {
        setMessages((prev) => prev.map((m) => (
            m.role === "tool" && (m.status === "running" || m.status === "awaiting-confirm")
                ? { ...m, status: "aborted" } : m
        )));
    };

    useEffect(() => {
        if (!sessionToken) return;

        let closedByUs = false;
        let retryTimer = null;
        let attempts = 0;
        setConnectionError(null);

        const conversationId = newConversationId();

        const connect = () => {
            const ws = new WebSocket(getWebSocketUrl("/api/ws/ai",
                { sessionToken, sessionId: session.id, conversationId }));
            wsRef.current = ws;

            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                switch (msg.type) {
                    case "ready": setReady(true); setConnectionError(null); attempts = 0; break;
                    case "text-delta": appendAssistant(msg.delta); break;
                    case "tool-call":
                        stopStreaming();
                        upsertTool(msg.callId, {}, { tool: msg.tool, args: msg.args, status: "running" });
                        break;
                    case "confirm-request":
                        upsertTool(msg.callId, { status: "awaiting-confirm", tool: msg.tool, args: msg.args },
                            { tool: msg.tool, args: msg.args, status: "awaiting-confirm" });
                        break;
                    case "tool-result":
                        upsertTool(msg.callId, { status: msg.result?.denied ? "denied" : "done", result: msg.result });
                        break;
                    case "tool-error":
                        upsertTool(msg.callId, { status: "error", error: msg.error });
                        break;
                    case "step-limit": stopStreaming(); setNeedsContinue(true); break;
                    case "compacted":
                        setMessages((prev) => [...prev, { role: "system", text: t("servers.aiAssistant.compacted") }]);
                        break;
                    case "done": stopStreaming(); setRunning(false); break;
                    case "aborted": stopStreaming(); finalizeRunningTools(); setRunning(false); setNeedsContinue(false); break;
                    case "error":
                        stopStreaming(); setRunning(false); setNeedsContinue(false);
                        setMessages((prev) => [...prev, { role: "system", text: msg.message }]);
                        break;
                    default: break;
                }
            };

            ws.onclose = (event) => {
                if (closedByUs) return;
                setReady(false);
                setRunning(false);
                stopStreaming();
                finalizeRunningTools();

                if (event.code >= 4000) {
                    setConnectionError(event.reason || t("servers.aiAssistant.connectionError"));
                    return;
                }
                if (event.code === 1000 || event.code === 1005) return;

                attempts += 1;
                if (attempts <= 5) {
                    setConnectionError(t("servers.aiAssistant.reconnecting"));
                    retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempts, 10000));
                } else {
                    setConnectionError(t("servers.aiAssistant.connectionError"));
                }
            };
            ws.onerror = () => {
                if (!closedByUs) setReady(false);
            };
        };

        connect();

        return () => {
            closedByUs = true;
            clearTimeout(retryTimer);
            const ws = wsRef.current;
            if (ws) {
                ws.onmessage = null;
                ws.onclose = null;
                ws.onerror = null;
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "close" }));
                ws.close();
            }
        };
    }, [sessionToken, session.id]);

    const stickToBottom = useRef(true);
    const onScroll = () => {
        const el = messagesRef.current;
        if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };

    useEffect(() => {
        if (stickToBottom.current) messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
    }, [messages]);

    useEffect(() => {
        if (ready) inputRef.current?.focus();
    }, [ready]);

    const sendPrompt = () => {
        const content = input.trim();
        if (!content || running || !ready) return;
        wsRef.current?.send(JSON.stringify({ type: "prompt", content }));
        setMessages((prev) => [...prev, { role: "user", text: content }]);
        setInput("");
        setNeedsContinue(false);
        setRunning(true);
    };

    const continueRun = () => {
        if (running || !ready) return;
        wsRef.current?.send(JSON.stringify({ type: "continue" }));
        setNeedsContinue(false);
        setRunning(true);
    };

    const stop = () => {
        wsRef.current?.send(JSON.stringify({ type: "abort" }));
        stopStreaming();
        finalizeRunningTools();
        setRunning(false);
        setNeedsContinue(false);
    };

    const confirmTool = useCallback((callId, allow) => {
        wsRef.current?.send(JSON.stringify({ type: "confirm", callId, allow }));
        upsertTool(callId, { status: allow ? "running" : "denied" });
    }, [upsertTool]);

    const pendingConfirmId = messages.find((m) => m.role === "tool" && m.status === "awaiting-confirm")?.callId ?? null;
    const acceptKeybind = getParsedKeybind?.("ai-accept-tool");
    const acceptHint = formatKey?.(getKeybind?.("ai-accept-tool"));

    useEffect(() => {
        if (!pendingConfirmId || !acceptKeybind) return;

        const handleAcceptShortcut = (e) => {
            if (!matchesKeybind(e, acceptKeybind)) return;
            e.preventDefault();
            e.stopPropagation();
            confirmTool(pendingConfirmId, true);
        };

        document.addEventListener("keydown", handleAcceptShortcut);
        return () => document.removeEventListener("keydown", handleAcceptShortcut);
    }, [pendingConfirmId, acceptKeybind]);

    const handleKeyDown = (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            sendPrompt();
        }
    };

    return (
        <FloatingWindow
            className="ai-assistant-window"
            icon={IconBotMessageSquare}
            title={t("servers.aiAssistant.title")}
            titleExtra={session.server?.name && <span className="target">{session.server.name}</span>}
            onClose={onClose}
            initialSize={{ width: 460, height: 620 }}
        >
            <div className="ai-assistant-messages" ref={messagesRef} onScroll={onScroll}>
                {messages.length === 0 && !connectionError && (
                    <div className="ai-assistant-empty">
                        <Icon icon={IconBotMessageSquare} />
                        <p>{t("servers.aiAssistant.empty")}</p>
                    </div>
                )}

                {messages.map((message, i) => {
                    if (message.role === "tool") {
                        return <ToolCard key={message.callId} message={message} onConfirm={confirmTool}
                                         acceptHint={acceptHint} />;
                    }
                    const key = `msg-${i}`;
                    if (message.role === "user") return <div key={key} className="message user"><MessageContent text={message.text} /></div>;
                    if (message.role === "assistant") return <div key={key} className="message assistant"><MessageContent text={message.text} /></div>;
                    return <div key={key} className="message system">{message.text}</div>;
                })}

                {needsContinue && !running && (
                    <div className="ai-continue">
                        <span>{t("servers.aiAssistant.continuePrompt")}</span>
                        <Button icon={IconPlay} text={t("servers.aiAssistant.continue")} onClick={continueRun}
                                disabled={!ready} />
                    </div>
                )}

                {running && <div className="ai-typing"><span /><span /><span /></div>}
                {connectionError && <div className="message system error">{connectionError}</div>}
            </div>

            <div className="ai-assistant-input">
                <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
                          onKeyDown={handleKeyDown} rows={1} disabled={!ready}
                          placeholder={ready ? t("servers.aiAssistant.placeholder") : t("servers.aiAssistant.connecting")} />
                {running ? (
                    <Button type="danger" icon={IconSquare} onClick={stop} title={t("servers.aiAssistant.stop")} />
                ) : (
                    <Button type="primary" icon={IconSend} onClick={sendPrompt} disabled={!input.trim() || !ready}
                            title={t("servers.aiAssistant.send")} />
                )}
            </div>
        </FloatingWindow>
    );
};

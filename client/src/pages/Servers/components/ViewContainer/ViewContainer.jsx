import "./styles.sass";
import ServerTabs from "./components/ServerTabs";
import TerminalKeyBar from "./components/TerminalKeyBar";
import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import GuacamoleRenderer from "@/pages/Servers/components/ViewContainer/renderer/GuacamoleRenderer.jsx";
import XtermRenderer from "@/pages/Servers/components/ViewContainer/renderer/XtermRenderer.jsx";
import FileRenderer from "@/pages/Servers/components/ViewContainer/renderer/FileRenderer";
import ScriptRenderer from "@/pages/Servers/components/ViewContainer/renderer/ScriptRenderer";
import NotesRenderer from "@/pages/Servers/components/ViewContainer/renderer/NotesRenderer";
import Icon from "@mdi/react";
import { mdiFullscreenExit } from "@mdi/js";
import { useTranslation } from "react-i18next";
import { getTitleBarHeight } from "@/common/utils/TauriUtil.js";
import { useTauriWindow } from "@/common/hooks/useTauriWindow.js";
import { useBodyClass } from "@/common/hooks/useBodyClass.js";
import { paneColorFor } from "./utils/paneColors.js";
import { barKeySequence } from "@/common/utils/keyBarSequences.js";

const BTN_SIZE = 44;
const BTN_STORAGE_KEY = "fullscreen-btn-position";
const EMPTY_LATCH = { ctrl: false, alt: false, shift: false };

// Mirrors tabLabel.js's own LIVE_TITLE_MAX_LENGTH (kept as a separate constant rather than an
// import - tabLabel.js is a pure module maintained outside this task). That module sanitizes and
// truncates for *display*, at render time, but nothing bounds how many raw characters a remote
// host can push in before that: xterm.js places no cap on an OSC 0/2 title payload, so without a
// limit here, a host the user doesn't control decides how much memory sits in `liveTitles`
// (unbounded, one entry per session, never pruned). Truncating here closes that door at the point
// the value enters state; sanitizing stays solely tabLabel.js's job.
const LIVE_TITLE_MAX_LENGTH = 80;

const getMinY = () => getTitleBarHeight() + 16;
const clampPosition = (x, y) => ({
    x: Math.max(0, Math.min(window.innerWidth - BTN_SIZE, x)),
    y: Math.max(getMinY(), Math.min(window.innerHeight - BTN_SIZE, y))
});

const loadBtnPosition = () => {
    try {
        const saved = JSON.parse(localStorage.getItem(BTN_STORAGE_KEY));
        if (saved) return clampPosition(saved.x, saved.y);
    } catch {}
    return { x: window.innerWidth - 60, y: getMinY() };
};

export const ViewContainer = ({
                                  activeSessions,
                                  activeSessionId,
                                  setActiveSessionId,
                                  disconnectFromServer,
                                  closeSession,
                                  hibernateSession,
                                  duplicateSession,
                                  openNotes,
                                  renameSession,
                                  markSessionErrored,
                                  getSessionError,
                                  setOpenFileEditors,
                                  openTerminalFromFileManager,
                                  tabIdentities,
                              }) => {
    const [layoutMode, setLayoutMode] = useState("single");
    const [gridSessions, setGridSessions] = useState([]);
    const sessionRefs = useRef({});
    const terminalRefs = useRef({});
    const guacamoleRefs = useRef({});
    const scriptStateRefs = useRef({});
    const tabOrderRef = useRef([]);
    const [broadcastMode, setBroadcastMode] = useState(false);
    const [modifierLatch, setModifierLatch] = useState(EMPTY_LATCH);
    const [sessionProgress, setSessionProgress] = useState({});
    // Keyed by session id, exactly like sessionProgress above: the tab strip needs the live
    // terminal title, but it must not join the session objects Servers.jsx builds - those feed
    // identitySignature, and a value that can change many times a second would drag the tab
    // numbering recompute along with it (see task-7-brief.md). Unlike sessionProgress's bounded
    // number, each entry here is a string a remote host chose the content of - updateLiveTitle
    // below caps its length, so an entry that outlives its session (this map is never pruned,
    // same as sessionProgress) stays a small leak rather than an unbounded one.
    const [liveTitles, setLiveTitles] = useState({});
    const [fullscreenMode, setFullscreenMode] = useState(false);
    const [titleBarTabsSlot, setTitleBarTabsSlot] = useState(null);
    const appWindow = useTauriWindow();
    const { t } = useTranslation();

    useEffect(() => {
        setTitleBarTabsSlot(document.getElementById("titlebar-tabs-slot"));
    }, []);

    useBodyClass("session-fullscreen", fullscreenMode);

    useEffect(() => {
        if (!appWindow) return;

        let cancelled = false, unlistenResized;
        (async () => {
            const syncFullscreen = async () => {
                const active = await appWindow.isFullscreen();
                if (!cancelled) setFullscreenMode(active);
            };
            await syncFullscreen();
            const unlisten = await appWindow.onResized(syncFullscreen);
            cancelled ? unlisten() : unlistenResized = unlisten;
        })();

        return () => {
            cancelled = true;
            unlistenResized?.();
        };
    }, [appWindow]);

    useEffect(() => {
        if (!appWindow) return;

        let cancelled = false;
        appWindow.isFullscreen().then(active => {
            if (!cancelled && active !== fullscreenMode) appWindow.setFullscreen(fullscreenMode);
        });

        return () => cancelled = true;
    }, [appWindow, fullscreenMode]);

    const [btnPosition, setBtnPosition] = useState(loadBtnPosition);
    const [isDragging, setIsDragging] = useState(false);
    const dragRef = useRef({ startX: 0, startY: 0, btnX: 0, btnY: 0 });

    const [columnSizes, setColumnSizes] = useState([]);
    const [rowSizes, setRowSizes] = useState([]);
    const [cellSizes, setCellSizes] = useState([]);
    const [isResizing, setIsResizing] = useState(false);
    const [resizingDirection, setResizingDirection] = useState(null);
    const resizeRef = useRef(null);
    const layoutRef = useRef(null);

    const activeSession = activeSessions.find(session => session.id === activeSessionId);
    const hasGuacamole = activeSession?.server?.renderer === "guac";

    const registerTerminalRef = useCallback((sessionId, refs) => {
        refs ? terminalRefs.current[sessionId] = refs : delete terminalRefs.current[sessionId];
    }, []);

    const registerGuacamoleRef = useCallback((sessionId, refs) => {
        refs ? guacamoleRefs.current[sessionId] = refs : delete guacamoleRefs.current[sessionId];
    }, []);

    const updateSessionProgress = useCallback((sessionId, progress) => {
        setSessionProgress(prev => ({
            ...prev,
            [sessionId]: progress,
        }));
    }, []);

    const updateLiveTitle = useCallback((sessionId, title) => {
        const bounded = title.length > LIVE_TITLE_MAX_LENGTH ? title.slice(0, LIVE_TITLE_MAX_LENGTH) : title;
        setLiveTitles(prev => ({
            ...prev,
            [sessionId]: bounded,
        }));
    }, []);

    const updateScriptState = useCallback((sessionId, state) => {
        scriptStateRefs.current[sessionId] = {
            ...scriptStateRefs.current[sessionId],
            ...state,
        };
    }, []);

    const getScriptState = useCallback((sessionId) => {
        return scriptStateRefs.current[sessionId] || null;
    }, []);

    const toggleBroadcastMode = useCallback(() => {
        setBroadcastMode(prev => !prev);
    }, []);

    const toggleModifier = useCallback((name) => {
        setModifierLatch((prev) => ({ ...prev, [name]: !prev[name] }));
    }, []);

    const clearLatch = useCallback(() => setModifierLatch(EMPTY_LATCH), []);

    const sendBarKey = useCallback((key) => {
        const sequence = barKeySequence(key, modifierLatch);
        if (!sequence) return;

        const term = terminalRefs.current[activeSessionId]?.term;
        // Nothing to send to while a session is still connecting or already
        // closing. Keep the latch: clearing it would signal success for
        // something that never happened.
        if (!term) return;

        // Through term.input rather than straight to the socket: that is the
        // path typed characters take, so broadcast and everything else hanging
        // off onData applies to the bar as well. applyLatchedModifiers leaves
        // the sequence alone because it is never a single printable character -
        // it does report the latch as spent, so onLatchConsumed has usually
        // fired by the time we get here. The line below is what covers the case
        // where it did not.
        term.input(sequence);
        setModifierLatch(EMPTY_LATCH);
    }, [modifierLatch, activeSessionId]);

    const toggleFullscreenMode = useCallback(() => {
        setFullscreenMode(prev => !prev);
    }, []);

    const onBtnMouseDown = useCallback((e) => {
        e.preventDefault();
        dragRef.current = { startX: e.clientX, startY: e.clientY, btnX: btnPosition.x, btnY: btnPosition.y };
        setIsDragging(true);
    }, [btnPosition]);

    useEffect(() => {
        if (!isDragging) return;
        const onMove = (e) => {
            const { startX, startY, btnX, btnY } = dragRef.current;
            setBtnPosition(clampPosition(btnX + e.clientX - startX, btnY + e.clientY - startY));
        };
        const onUp = () => {
            setIsDragging(false);
            try { localStorage.setItem(BTN_STORAGE_KEY, JSON.stringify(btnPosition)); } catch {}
        };
        document.addEventListener("mousemove", onMove, true);
        document.addEventListener("mouseup", onUp, true);
        return () => {
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("mouseup", onUp, true);
        };
    }, [isDragging, btnPosition]);

    useEffect(() => {
        const onResize = () => setBtnPosition(prev => clampPosition(prev.x, prev.y));
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    const onBtnClick = useCallback((e) => {
        const { startX, startY } = dragRef.current;
        if (Math.abs(e.clientX - startX) < 5 && Math.abs(e.clientY - startY) < 5) toggleFullscreenMode();
    }, [toggleFullscreenMode]);

    const handleKeyboardShortcut = useCallback((keys) => {
        const activeGuacamole = guacamoleRefs.current[activeSessionId];
        if (activeGuacamole && activeGuacamole.client) {
            keys.forEach(key => activeGuacamole.client.sendKeyEvent(1, key));
            setTimeout(() => {
                [...keys].reverse().forEach(key => activeGuacamole.client.sendKeyEvent(0, key));
            }, 50);
        }
    }, [activeSessionId]);

    const handleSnippetSelected = useCallback((command) => {
        const commandWithNewline = command.endsWith("\n") ? command : command + "\n";

        if (broadcastMode && layoutMode !== "single") {
            Object.entries(terminalRefs.current).forEach(([, { ws }]) => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(commandWithNewline);
                }
            });

            Object.entries(guacamoleRefs.current).forEach(([, { client }]) => {
                if (client) {
                    for (let i = 0; i < command.length; i++) {
                        const char = command.charCodeAt(i);
                        setTimeout(() => {
                            client.sendKeyEvent(1, char);
                            setTimeout(() => client.sendKeyEvent(0, char), 10);
                        }, i * 20);
                    }
                    if (commandWithNewline.endsWith("\n")) {
                        setTimeout(() => {
                            client.sendKeyEvent(1, 0xff0d);
                            setTimeout(() => client.sendKeyEvent(0, 0xff0d), 10);
                        }, command.length * 20);
                    }
                }
            });
        } else {
            const activeSession = activeSessions.find(s => s.id === activeSessionId);

            if (activeSession?.server?.renderer === "terminal") {
                const activeTerminal = terminalRefs.current[activeSessionId];
                if (activeTerminal && activeTerminal.ws && activeTerminal.ws.readyState === WebSocket.OPEN) {
                    activeTerminal.ws.send(commandWithNewline);
                    if (activeTerminal.term) {
                        activeTerminal.term.focus();
                    }
                }
            } else if (activeSession?.server?.renderer === "guac") {
                const activeGuacamole = guacamoleRefs.current[activeSessionId];
                if (activeGuacamole && activeGuacamole.client) {
                    for (let i = 0; i < command.length; i++) {
                        const char = command.charCodeAt(i);
                        setTimeout(() => {
                            activeGuacamole.client.sendKeyEvent(1, char);
                            setTimeout(() => activeGuacamole.client.sendKeyEvent(0, char), 10);
                        }, i * 20);
                    }
                    if (commandWithNewline.endsWith("\n")) {
                        setTimeout(() => {
                            activeGuacamole.client.sendKeyEvent(1, 0xff0d);
                            setTimeout(() => activeGuacamole.client.sendKeyEvent(0, 0xff0d), 10);
                        }, command.length * 20);
                    }
                }
            }
        }
    }, [layoutMode, activeSessionId, broadcastMode, activeSessions]);

    useEffect(() => {
        if (layoutMode === "single") {
            setBroadcastMode(false);
        }
    }, [layoutMode]);

    const onTabOrderChange = useCallback((newOrder) => {
        tabOrderRef.current = newOrder;
        if (layoutMode !== "single") {
            const filteredOrder = newOrder.filter(id => activeSessions.some(session => session.id === id));
            if (filteredOrder.length > 0) setGridSessions(filteredOrder);
        }
    }, [layoutMode, activeSessions]);

    const focusSession = useCallback((sessionId) => {
        setActiveSessionId(sessionId);

        setTimeout(() => {
            const sessionElement = sessionRefs.current[sessionId];
            if (sessionElement) {
                const terminalElement = sessionElement.querySelector("canvas, textarea, input, [tabindex]");
                if (terminalElement) {
                    terminalElement.focus();
                } else {
                    sessionElement.setAttribute("tabindex", "-1");
                    sessionElement.focus();
                }
            }
        }, 100);
    }, [setActiveSessionId]);

    const initializeGridSizes = useCallback(({ rows, cols }) => {
        setColumnSizes(Array(cols).fill(1));
        setRowSizes(Array(rows).fill(1));
        setCellSizes(Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ width: 1, height: 1 }))));
    }, []);

    const handleResizerMouseDown = useCallback((e, type, index, rowIndex = null) => {
        e.preventDefault();
        e.stopPropagation();
        setIsResizing(true);
        setResizingDirection(type);

        const layoutElement = layoutRef.current;
        if (!layoutElement) return;

        const layoutRect = layoutElement.getBoundingClientRect();
        const totalSize = type === "vertical" ? layoutRect.width : layoutRect.height;
        const layoutStart = type === "vertical" ? layoutRect.left : layoutRect.top;

        const isSegmentResize = rowIndex !== null && type === "vertical";
        const initialCellSizes = cellSizes.map(row => row.map(cell => ({ ...cell })));
        const initialRowSizes = [...rowSizes];
        const totalRowSize = initialRowSizes.reduce((sum, size) => sum + size, 0) || 1;

        const handleMouseMove = (moveEvent) => {
            const currentPos = type === "vertical" ? moveEvent.clientX : moveEvent.clientY;
            const relativePos = Math.max(0, Math.min(totalSize, currentPos - layoutStart));
            const mouseRatio = relativePos / totalSize;

            if (type === "vertical" && isSegmentResize && initialCellSizes[rowIndex]) {
                setCellSizes(prev => {
                    const newSizes = prev.map(row => row.map(cell => ({ ...cell })));
                    if (newSizes[rowIndex] && index < newSizes[rowIndex].length - 1) {
                        const rowCells = initialCellSizes[rowIndex];
                        const totalRowWidth = rowCells.reduce((sum, cell) => sum + cell.width, 0);
                        const widthsBefore = rowCells.slice(0, index).reduce((sum, cell) => sum + cell.width, 0);
                        const twoCellWidth = rowCells[index].width + rowCells[index + 1].width;

                        const targetWidth = (mouseRatio * totalRowWidth) - widthsBefore;
                        const clampedWidth = Math.max(0.15, Math.min(twoCellWidth - 0.15, targetWidth));

                        newSizes[rowIndex][index].width = clampedWidth;
                        newSizes[rowIndex][index + 1].width = twoCellWidth - clampedWidth;
                    }
                    return newSizes;
                });
            } else if (type === "horizontal") {
                setRowSizes(prev => {
                    const newSizes = [...prev];
                    if (index < newSizes.length - 1) {
                        const heightsBefore = initialRowSizes.slice(0, index).reduce((sum, size) => sum + size, 0);
                        const twoRowTotal = initialRowSizes[index] + initialRowSizes[index + 1];
                        const targetFirstRow = (mouseRatio * totalRowSize) - heightsBefore;
                        const clampedFirstRow = Math.max(0.15, Math.min(twoRowTotal - 0.15, targetFirstRow));
                        newSizes[index] = clampedFirstRow;
                        newSizes[index + 1] = twoRowTotal - clampedFirstRow;
                    }
                    return newSizes;
                });
            }
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            setResizingDirection(null);
            document.removeEventListener("mousemove", handleMouseMove, true);
            document.removeEventListener("mouseup", handleMouseUp, true);
        };

        document.addEventListener("mousemove", handleMouseMove, true);
        document.addEventListener("mouseup", handleMouseUp, true);

        resizeRef.current = { type, index, handleMouseMove, handleMouseUp };
    }, [cellSizes, rowSizes]);

    const getDynamicLayout = (n) => {
        const layouts = { 1: [1,1], 2: [1,2], 3: [2,2], 4: [2,2], 5: [3,2], 6: [2,3] };
        const [rows, cols] = layouts[n] || [Math.ceil(n / Math.ceil(Math.sqrt(n))), Math.ceil(Math.sqrt(n))];
        return { mode: n <= 1 ? "single" : `grid-${rows}x${cols}`, rows, cols };
    };

    const toggleSplitMode = () => {
        if (layoutMode === "single") {
            const layout = getDynamicLayout(activeSessions.length);
            setLayoutMode(layout.mode);
            setGridSessions(tabOrderRef.current?.length ? tabOrderRef.current : activeSessions.map(s => s.id));
            initializeGridSizes(layout);
        } else {
            setLayoutMode("single");
            setGridSessions([]);
            setColumnSizes([]);
            setRowSizes([]);
            setCellSizes([]);
        }
    };

    const prevSessionCountRef = useRef(activeSessions.length);

    useEffect(() => {
        if (layoutMode === "single") return;
        const layout = getDynamicLayout(activeSessions.length);
        if (layout.mode !== layoutMode) setLayoutMode(layout.mode);
        setGridSessions(tabOrderRef.current?.length ? tabOrderRef.current : activeSessions.map(s => s.id));
        if (prevSessionCountRef.current !== activeSessions.length) {
            initializeGridSizes(layout);
            prevSessionCountRef.current = activeSessions.length;
        }
    }, [activeSessions, layoutMode, initializeGridSizes]);

    useEffect(() => {
        if (activeSessionId && activeSessions.some(session => session.id === activeSessionId)) {
            focusSession(activeSessionId);
        }
    }, [activeSessions.length, activeSessionId, focusSession]);

    useEffect(() => {
        setModifierLatch(EMPTY_LATCH);
    }, [activeSessionId]);

    const renderRenderer = (session) => {
        if (session.type === "notes") {
            return <NotesRenderer session={session} />;
        }

        if (session.scriptId) {
            return <ScriptRenderer
                session={session}
                disconnectFromServer={disconnectFromServer}
                markSessionErrored={markSessionErrored}
                getSessionError={getSessionError}
                updateProgress={updateSessionProgress}
                savedState={getScriptState(session.id)}
                saveState={(state) => updateScriptState(session.id, state)} />;
        }

        const renderer = session.type || session.server.renderer;

        switch (renderer) {
            case "guac":
                return <GuacamoleRenderer session={session} disconnectFromServer={disconnectFromServer}
                                          markSessionErrored={markSessionErrored}
                                          getSessionError={getSessionError}
                                          registerGuacamoleRef={registerGuacamoleRef}
                                          isShared={!!session.isJoined}
                                          fullscreenEnabled={fullscreenMode}
                                          onFullscreenToggle={toggleFullscreenMode} />;
            case "terminal":
                return <XtermRenderer session={session} disconnectFromServer={disconnectFromServer}
                                      isShared={!!session.isJoined}
                                      markSessionErrored={markSessionErrored}
                                      getSessionError={getSessionError}
                                      registerTerminalRef={registerTerminalRef} broadcastMode={broadcastMode}
                                      modifierLatch={modifierLatch} onLatchConsumed={clearLatch}
                                      terminalRefs={terminalRefs} updateProgress={updateSessionProgress}
                                      updateTitle={updateLiveTitle}
                                      layoutMode={layoutMode} onBroadcastToggle={toggleBroadcastMode}
                                      onFullscreenToggle={toggleFullscreenMode} />;
            case "sftp":
            case "onedrive":
                return <FileRenderer session={session} disconnectFromServer={disconnectFromServer}
                                     setOpenFileEditors={setOpenFileEditors} isActive={session.id === activeSessionId}
                                     onOpenTerminal={(path) => openTerminalFromFileManager?.(session.id, path)} />;
            default:
                return <p>Unknown renderer: {renderer}</p>;
        }
    };

    const renderFlexLayout = () => {
        const { rows, cols } = getDynamicLayout(gridSessions.length);
        const totalRowHeight = rowSizes.reduce((sum, s) => sum + s, 0) || rows;
        const resizers = [];
        const dividerSize = 3;
        const halfDivider = dividerSize / 2;

        let cumHeight = 0;
        for (let r = 0; r < rows - 1; r++) {
            cumHeight += (rowSizes[r] || 1) / totalRowHeight;
            resizers.push(
                <div key={`h-${r}`} className="grid-resizer horizontal"
                     style={{ position: 'absolute', top: `calc(${cumHeight * 100}% - ${halfDivider}px)`, left: 0, height: dividerSize, width: "100%", cursor: "row-resize", zIndex: 10 }}
                     onMouseDown={(e) => handleResizerMouseDown(e, "horizontal", r, null)} />
            );
        }

        for (let r = 0; r < rows; r++) {
            const sessionsInRow = Math.min(cols, gridSessions.length - r * cols);
            const rowCellWidths = (cellSizes[r] || columnSizes).slice(0, sessionsInRow).map(c => c?.width ?? 1);
            const totalRowWidth = rowCellWidths.reduce((sum, w) => sum + w, 0) || cols;
            const rowStart = r > 0 ? rowSizes.slice(0, r).reduce((sum, s) => sum + s, 0) / totalRowHeight : 0;
            const rowHeight = (rowSizes[r] || 1) / totalRowHeight;
            let cumWidth = 0;
            for (let c = 0; c < sessionsInRow - 1; c++) {
                cumWidth += (rowCellWidths[c] || 1) / totalRowWidth;
                resizers.push(
                    <div key={`v-${r}-${c}`} className="grid-resizer vertical"
                         style={{ position: 'absolute', left: `calc(${cumWidth * 100}% - ${halfDivider}px)`, top: `${rowStart * 100}%`, width: dividerSize, height: `${rowHeight * 100}%`, cursor: "col-resize", zIndex: 10 }}
                         onMouseDown={(e) => handleResizerMouseDown(e, "vertical", c, r)} />
                );
            }
        }
        return resizers;
    };

    const getSessionStyle = (session) => {
        if (layoutMode === "single") {
            const v = session.id === activeSessionId;
            return { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", zIndex: v ? 1 : -1, opacity: v ? 1 : 0, pointerEvents: v ? "auto" : "none" };
        }
        const gridIndex = gridSessions.indexOf(session.id);
        if (gridIndex === -1) return { position: "absolute", opacity: 0, pointerEvents: "none", zIndex: -1 };

        const { rows, cols } = getDynamicLayout(gridSessions.length);
        const rowIdx = Math.floor(gridIndex / cols), colIdx = gridIndex % cols;
        const totalRowHeight = rowSizes.reduce((sum, s) => sum + s, 0) || rows;
        const rowStart = rowIdx > 0 ? rowSizes.slice(0, rowIdx).reduce((sum, s) => sum + s, 0) / totalRowHeight * 100 : 0;
        const rowHeight = (rowSizes[rowIdx] || 1) / totalRowHeight * 100;
        const sessionsInRow = Math.min(cols, gridSessions.length - rowIdx * cols);
        const rowCellWidths = (cellSizes[rowIdx] || Array(sessionsInRow).fill({ width: 1 })).slice(0, sessionsInRow).map(c => c?.width ?? 1);
        const totalRowWidth = rowCellWidths.reduce((sum, w) => sum + w, 0) || sessionsInRow;
        const colStart = colIdx > 0 ? rowCellWidths.slice(0, colIdx).reduce((sum, w) => sum + w, 0) / totalRowWidth * 100 : 0;
        const spanFull = gridIndex === gridSessions.length - 1 && rowIdx === rows - 1 && gridSessions.length - (rows - 1) * cols === 1;
        const colWidth = spanFull ? 100 : (rowCellWidths[colIdx] || 1) / totalRowWidth * 100;

        const gapSize = 3;
        const isFirstRow = rowIdx === 0;
        const isLastRow = rowIdx === rows - 1;
        const isFirstCol = colIdx === 0;
        const isLastCol = spanFull || colIdx === sessionsInRow - 1;

        const topAdjust = isFirstRow ? 0 : gapSize / 2;
        const bottomAdjust = isLastRow ? 0 : gapSize / 2;
        const leftAdjust = isFirstCol ? 0 : gapSize / 2;
        const rightAdjust = isLastCol ? 0 : gapSize / 2;

        return { 
            position: "absolute", 
            top: `calc(${rowStart}% + ${topAdjust}px)`, 
            left: spanFull ? 0 : `calc(${colStart}% + ${leftAdjust}px)`, 
            width: spanFull ? '100%' : `calc(${colWidth}% - ${leftAdjust + rightAdjust}px)`, 
            height: `calc(${rowHeight}% - ${topAdjust + bottomAdjust}px)`, 
            zIndex: 1 
        };
    };

    // gridSessions survives a collapse to one session (the effect above refills it in the same
    // pass that switches layoutMode to "single"), so it alone would colour a pane in single view.
    // One derivation, asked by both the grid and the tab strip — so they cannot disagree.
    const paneColorSessions = layoutMode === "single" ? [] : gridSessions;

    const renderAllSessions = () => activeSessions.map(session => {
        // A OneDrive session has no `server` — its identity is the Microsoft connection id — so the
        // guard that used to mean "not ready yet" would otherwise hide it from the layout forever.
        if (!session?.server && session?.type !== "onedrive") return null;
        const isVisible = layoutMode === "single" ? session.id === activeSessionId : gridSessions.includes(session.id);
        const paneColor = paneColorFor(paneColorSessions.indexOf(session.id));
        // Drives the split-view border's strong/faint state in CSS. Deliberately not
        // :focus-within: a portalled overlay (e.g. ContextMenu, which moves focus to itself on
        // open) would blank every pane at once and never hand focus back on close. This mirrors
        // activeSessionId directly instead, the same source ServerTabs already uses.
        const isActive = session.id === activeSessionId;
        return (
            <div key={session.id} ref={el => sessionRefs.current[session.id] = el}
                 className={`session-renderer ${isVisible ? "visible" : "hidden"} ${isActive ? "active" : ""}`}
                 onClick={() => session.id !== activeSessionId && focusSession(session.id)}
                 style={{ ...getSessionStyle(session), ...(paneColor && { "--pane-color": paneColor }) }}>
                {renderRenderer(session)}
            </div>
        );
    });

    const serverTabs = fullscreenMode && !titleBarTabsSlot ? null : (
        <ServerTabs activeSessions={activeSessions} setActiveSessionId={focusSession}
                    activeSessionId={activeSessionId}
                    closeSession={closeSession}
                    layoutMode={layoutMode} onToggleSplit={toggleSplitMode}
                    paneColorSessions={paneColorSessions}
                    tabIdentities={tabIdentities}
                    orderRef={tabOrderRef}
                    onTabOrderChange={onTabOrderChange} onBroadcastToggle={toggleBroadcastMode}
                    onSnippetSelected={handleSnippetSelected} broadcastEnabled={broadcastMode}
                    onKeyboardShortcut={handleKeyboardShortcut} hasGuacamole={hasGuacamole}
                    sessionProgress={sessionProgress} liveTitles={liveTitles} fullscreenEnabled={fullscreenMode}
                    onFullscreenToggle={toggleFullscreenMode}
                    openNotes={openNotes} renameSession={renameSession}
                    hibernateSession={hibernateSession} duplicateSession={duplicateSession} />
    );

    return (
        <div className={`view-container ${fullscreenMode ? "fullscreen" : ""}`}>
            {fullscreenMode && !hasGuacamole && !titleBarTabsSlot && (
                <div
                    className={`exit-fullscreen-btn-container ${isDragging ? "dragging" : ""}`}
                    style={{ left: btnPosition.x, top: btnPosition.y }}
                    onMouseDown={onBtnMouseDown}
                    onClick={onBtnClick}
                    title={t("servers.terminalActions.exitFullScreen")}
                >
                    <button className="exit-fullscreen-btn">
                        <Icon path={mdiFullscreenExit} />
                    </button>
                </div>
            )}
            {titleBarTabsSlot ? createPortal(serverTabs, titleBarTabsSlot) : serverTabs}

            {activeSession && !hasGuacamole && (
                <TerminalKeyBar latch={modifierLatch}
                                onToggleModifier={toggleModifier}
                                onSendKey={sendBarKey} />
            )}

            {/* The bar sits above the layouter and takes real room, so the
                layouter has to give that room up. --key-bar-height is 0px
                wherever the bar is not shown, leaving this at exactly 100%. */}
            <div ref={layoutRef}
                 className={`view-layouter ${layoutMode} ${isResizing ? "resizing" : ""} ${isResizing && resizingDirection ? `resizing-${resizingDirection}` : ""}`}
                 style={{ position: "relative", width: "100%", height: "calc(100% - var(--key-bar-height))" }}>
                {renderAllSessions()}
                {layoutMode !== "single" && renderFlexLayout()}
            </div>

        </div>
    );
};
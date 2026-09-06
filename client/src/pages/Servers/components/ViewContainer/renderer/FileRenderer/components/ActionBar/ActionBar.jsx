import "./styles.sass";
import Icon from "@/common/components/Icon";
import { ChevronLeft as IconChevronLeft, ChevronRight as IconChevronRight, ChevronUp as IconChevronUp, FileUp as IconFileUp, FolderUp as IconFolderUp, FilePlus as IconFilePlus, FolderPlus as IconFolderPlus, List as IconList, Rows3 as IconRows3, LayoutGrid as IconLayoutGrid, Scissors as IconScissors, Copy as IconCopy, Search as IconSearch, X as IconX, RefreshCw as IconRefreshCw } from "lucide-react";
import { Fragment, useState, useRef, useEffect, useCallback } from "react";
import { ContextMenu, ContextMenuItem, useContextMenu } from "@/common/components/ContextMenu";
import { useTranslation } from "react-i18next";
import { usePreferences } from "@/common/contexts/PreferencesContext.jsx";
import { resolveDropTarget } from "../../utils/dropTransfer.js";
import { DEFAULT_CAPABILITIES } from "../../utils/paneCapabilities.js";
import { VIEW_DETAILS, VIEW_COMPACT, VIEW_GRID, nextViewMode } from "../../utils/viewModes.js";

// Icon per view mode. The action bar shows one icon at a time - the next mode nextViewMode()
// points to - so a fourth view only needs an entry here rather than another branch of
// conditional icon logic.
const VIEW_MODE_ICONS = {
    [VIEW_DETAILS]: IconList,
    [VIEW_COMPACT]: IconRows3,
    [VIEW_GRID]: IconLayoutGrid,
};

export const ActionBar = ({
                              path,
                              updatePath,
                              createFile,
                              createFolder,
                              uploadFile,
                              uploadFolder,
                              refreshFiles,
                              goBack,
                              goForward,
                              historyIndex,
                              historyLength,
                              viewMode = VIEW_DETAILS,
                              setViewMode,
                              searchDirectories,
                              directorySuggestions = [],
                              setDirectorySuggestions,
                              moveFiles,
                              copyFiles,
                              startTransfer,
                              sessionId,
                              searchQuery,
                              setSearchQuery,
                              searchOpen,
                              setSearchOpen,
                              closeSearch,
                              searchResultCount,
                              capabilities = DEFAULT_CAPABILITIES,
                          }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editPath, setEditPath] = useState(path);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [selectedSuggestion, setSelectedSuggestion] = useState(-1);
    const [pendingDrop, setPendingDrop] = useState(null);
    const { t } = useTranslation();
    const { dragDropAction } = usePreferences();
    const dropMenu = useContextMenu();

    const inputRef = useRef(null);
    const searchInputRef = useRef(null);
    const suggestionsRef = useRef(null);
    const breadcrumbRef = useRef(null);
    const isNavigatingWithKeyboardRef = useRef(false);
    const hoverTimerRef = useRef(null);

    const [dropTarget, setDropTarget] = useState(null);

    const getPathArray = () => path.split("/").filter(Boolean);

    const goUp = () => {
        const pathArray = getPathArray();
        pathArray.pop();
        updatePath(pathArray.length ? `/${pathArray.join("/")}` : "/");
    };

    const navigate = (displayIndex, isTruncated = false, originalIndex = null) => {
        const pathArray = getPathArray();
        const target = `/${pathArray.slice(0, (isTruncated ? originalIndex : displayIndex) + 1).join("/")}`;
        target === path ? refreshFiles?.() : updatePath(target);
    };

    const getTruncatedPathArray = () => {
        const pathArray = getPathArray();
        const total = pathArray.length;

        if (total <= 2 || !breadcrumbRef.current) {
            return { parts: pathArray, showEllipsis: total > 2, ellipsisIndex: 1, originalLength: total };
        }

        const containerWidth = breadcrumbRef.current.offsetWidth;
        const avgWidth = 80;
        const ellipsisWidth = 50;
        const available = containerWidth - 20 - ellipsisWidth;
        const maxParts = Math.floor(available / avgWidth);

        if (maxParts >= total) return { parts: pathArray, showEllipsis: false, ellipsisIndex: -1 };

        const visibleParts = Math.max(2, Math.min(maxParts, total));
        const end = Math.ceil(visibleParts / 2);
        const start = visibleParts - end;

        return {
            parts: [...pathArray.slice(0, start), ...pathArray.slice(-end)],
            showEllipsis: true,
            ellipsisIndex: start,
            originalLength: total,
        };
    };

    useEffect(() => {
        setEditPath(path);
    }, [path]);

    useEffect(() => {
        if (searchOpen) searchInputRef.current?.focus();
    }, [searchOpen]);

    const handleSearchKeyDown = (e) => {
        if (e.key === "Escape") {
            e.preventDefault();
            closeSearch?.();
        }
    };

    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.setSelectionRange(editPath.length, editPath.length);
        }
    }, [isEditing]);

    useEffect(() => {
        if (!isEditing) return;

        if (editPath.length <= 1) {
            setShowSuggestions(false);
            setDirectorySuggestions?.([]);
            setSelectedSuggestion(-1);
            return;
        }

        const timeout = setTimeout(() => {
            searchDirectories?.(editPath);
            setShowSuggestions(true);
            if (!isNavigatingWithKeyboardRef.current) setSelectedSuggestion(-1);
            isNavigatingWithKeyboardRef.current = false;
        }, 300);

        return () => clearTimeout(timeout);
    }, [editPath, isEditing]);

    const handleInputKeyDown = (e) => {
        switch (e.key) {
            case "Enter": {
                e.preventDefault();
                const suggestion = directorySuggestions[selectedSuggestion];
                if (selectedSuggestion >= 0 && suggestion) {
                    setEditPath(suggestion);
                    updatePath(suggestion);
                    resetInputState();
                } else {
                    submitPath();
                }
                break;
            }
            case "Escape":
                cancelEdit();
                break;
            case "ArrowDown":
            case "ArrowUp":
                e.preventDefault();
                if (!directorySuggestions.length) return;
                isNavigatingWithKeyboardRef.current = true;
                setSelectedSuggestion((prev) => {
                    const len = directorySuggestions.length;
                    const newIndex = e.key === "ArrowDown"
                        ? (prev + 1) % len
                        : (prev - 1 + len) % len;

                    requestAnimationFrame(() => {
                        suggestionsRef.current?.children[newIndex]?.scrollIntoView({
                            block: "nearest",
                            behavior: "smooth",
                        });
                    });
                    return newIndex;
                });
                break;
            case "Tab": {
                e.preventDefault();
                const tabSuggestion = directorySuggestions[selectedSuggestion];
                if (tabSuggestion) {
                    const pathWithSlash = tabSuggestion.endsWith('/') ? tabSuggestion : tabSuggestion + '/';
                    setEditPath(pathWithSlash);
                    setShowSuggestions(false);
                    setDirectorySuggestions?.([]);
                }
                break;
            }
        }
    };

    const submitPath = () => {
        let newPath = editPath.trim();
        if (!newPath.startsWith("/")) newPath = "/" + newPath;
        if (newPath.length > 1 && newPath.endsWith("/")) newPath = newPath.slice(0, -1);
        updatePath(newPath);
        resetInputState();
    };

    const cancelEdit = () => {
        setEditPath(path);
        resetInputState();
    };

    const resetInputState = () => {
        setIsEditing(false);
        setShowSuggestions(false);
        setDirectorySuggestions?.([]);
    };

    const handleInputBlur = (e) => {
        if (suggestionsRef.current?.contains(e.relatedTarget)) return;
        setTimeout(() => {
            if (!showSuggestions) submitPath();
        }, 100);
    };

    const handlePathDragOver = useCallback((event, targetPath) => {
        if (!event.dataTransfer.types.includes("application/x-sftp-files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? "copy" : "move";
        if (dropTarget !== targetPath) {
            setDropTarget(targetPath);
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = setTimeout(() => {
                updatePath(targetPath);
                setDropTarget(null);
            }, 800);
        }
    }, [dropTarget, updatePath]);

    const handlePathDragLeave = useCallback(() => {
        setDropTarget(null);
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    }, []);

    const applyDrop = useCallback((decision, action) => {
        if (decision.kind === "transfer") {
            startTransfer?.({
                paths: decision.paths, destination: decision.destination,
                sourceSessionId: decision.sourceSessionId, source: decision.source, action,
            });
        } else if (action === "move") {
            moveFiles?.(decision.paths, decision.destination);
        } else {
            copyFiles?.(decision.paths, decision.destination);
        }
    }, [moveFiles, copyFiles, startTransfer]);

    const handlePathDrop = useCallback((event, targetPath) => {
        event.preventDefault();
        event.stopPropagation();
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
        setDropTarget(null);
        try {
            const data = JSON.parse(event.dataTransfer.getData("application/x-sftp-files"));
            const decision = resolveDropTarget({ data, sessionId, destination: targetPath });
            if (decision.kind === "reject") return;
            if (dragDropAction === "move" || dragDropAction === "copy") {
                applyDrop(decision, dragDropAction);
            } else {
                setPendingDrop(decision);
                dropMenu.open(event, { x: event.clientX, y: event.clientY });
            }
        } catch {}
    }, [sessionId, dropMenu, dragDropAction, applyDrop]);

    const handleDropAction = useCallback((action) => {
        if (pendingDrop) {
            applyDrop(pendingDrop, action);
            setPendingDrop(null);
        }
        dropMenu.close();
    }, [pendingDrop, applyDrop, dropMenu]);

    const renderBreadcrumbs = () => {
        const { parts, showEllipsis, ellipsisIndex, originalLength } = getTruncatedPathArray();
        const fullArray = getPathArray();

        return (
            <>
                <div 
                    className={`path-part-divider root-drop ${dropTarget === "/" ? "drop-target" : ""}`}
                    onClick={(e) => { e.stopPropagation(); path === "/" ? refreshFiles?.() : updatePath("/"); }}
                    onDragOver={(e) => handlePathDragOver(e, "/")}
                    onDragLeave={handlePathDragLeave}
                    onDrop={(e) => handlePathDrop(e, "/")}
                >/
                </div>
                {parts.map((part, i) => {
                    const originalIndex = showEllipsis ? (i === 0 ? 0 : fullArray.length - (parts.length - i)) : i;
                    const targetPath = `/${fullArray.slice(0, originalIndex + 1).join("/")}`;
                    const isDropping = dropTarget === targetPath;

                    return (
                        <Fragment key={`${originalIndex}-${part}`}>
                            {showEllipsis && i === ellipsisIndex && (
                                <>
                                    <div className="path-part ellipsis"
                                         title={t("servers.fileManager.actionBar.hiddenDirectories", { count: originalLength - parts.length + 1 })}>
                                        ...
                                    </div>
                                    <div className="path-part-divider">/</div>
                                </>
                            )}
                            <div 
                                title={part} 
                                className={`path-part ${isDropping ? "drop-target" : ""}`}
                                onClick={(e) => { e.stopPropagation(); navigate(i, showEllipsis, originalIndex); }}
                                onDragOver={(e) => handlePathDragOver(e, targetPath)}
                                onDragLeave={handlePathDragLeave}
                                onDrop={(e) => handlePathDrop(e, targetPath)}
                            >{part}</div>
                            <div className="path-part-divider">/</div>
                        </Fragment>
                    );
                })}
            </>
        );
    };

    return (
        <div className="action-bar">
            <Icon icon={IconChevronLeft} onClick={goBack} className={historyIndex === 0 ? " nav-disabled" : ""} />
            <Icon icon={IconChevronRight} onClick={goForward}
                  className={historyIndex === historyLength - 1 ? " nav-disabled" : ""} />
            <Icon icon={IconChevronUp} onClick={goUp} className={path === "/" ? " nav-disabled" : ""} />

            <div className="address-bar" onClick={() => setIsEditing(true)}>
                {isEditing ? (
                    <div className="path-input-container">
                        <input ref={inputRef} className="path-input" type="text" value={editPath}
                               onChange={(e) => setEditPath(e.target.value)} onKeyDown={handleInputKeyDown}
                               onBlur={handleInputBlur} placeholder={t("servers.fileManager.actionBar.enterDirectory")} autoComplete="off"
                               spellCheck="false" />
                        {capabilities.nativeFs && showSuggestions && directorySuggestions.length > 0 && (
                            <div className="suggestions-dropdown" ref={suggestionsRef}>
                                {directorySuggestions.map((s, i) => (
                                    <div className={`suggestion-item ${i === selectedSuggestion ? "selected" : ""}`}
                                         key={s} onMouseEnter={() => setSelectedSuggestion(i)}
                                         onMouseDown={(e) => {
                                             e.preventDefault();
                                             setEditPath(s);
                                             updatePath(s);
                                             resetInputState();
                                         }}>
                                        {s}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="breadcrumb-container" ref={breadcrumbRef}>
                        {renderBreadcrumbs()}
                    </div>
                )}
            </div>

            {searchOpen && (
                <div className="file-search">
                    <input ref={searchInputRef} className="search-input" type="text" value={searchQuery}
                           onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={handleSearchKeyDown}
                           placeholder={t("servers.fileManager.search.placeholder")} autoComplete="off" spellCheck="false" />
                    {searchQuery.trim() && (
                        <span className="search-count">{t("servers.fileManager.search.results", { count: searchResultCount })}</span>
                    )}
                    <Icon icon={IconX} className="search-close" onClick={closeSearch}
                          title={t("servers.fileManager.actionBar.closeSearch")} />
                </div>
            )}

            <div className="file-actions">
                <Icon icon={IconSearch} onClick={() => searchOpen ? closeSearch?.() : setSearchOpen?.(true)}
                      className={searchOpen ? "active" : ""} title={t("servers.fileManager.actionBar.search")} />
                <Icon icon={VIEW_MODE_ICONS[nextViewMode(viewMode)]} onClick={() => setViewMode(nextViewMode(viewMode))}
                      title={t("servers.fileManager.actionBar.switchTo",
                          { view: t(`servers.fileManager.viewMode.${nextViewMode(viewMode)}`) })} />
                <Icon icon={IconRefreshCw} onClick={refreshFiles} title={t("servers.fileManager.actionBar.refresh")} />
                {capabilities.content && <>
                    <Icon icon={IconFileUp} onClick={uploadFile} title={t("servers.fileManager.actionBar.uploadFile")} />
                    <Icon icon={IconFolderUp} onClick={uploadFolder} title={t("servers.fileManager.actionBar.uploadFolder")} />
                </>}
                {capabilities.nativeFs && <Icon icon={IconFilePlus} onClick={createFile} />}
                <Icon icon={IconFolderPlus} onClick={createFolder} />
            </div>

            <ContextMenu isOpen={dropMenu.isOpen} position={dropMenu.position} onClose={() => { dropMenu.close(); setPendingDrop(null); }}>
                <ContextMenuItem icon={IconScissors} label={t("servers.fileManager.contextMenu.moveHere")} onClick={() => handleDropAction("move")} />
                {/* A copy within the session shells out to `cp -r` on a server and needs one, but
                    OneDrive does it with a Graph call — hence `copy` rather than `shell`. A copy
                    across pane boundaries streams over the transfer seam and needs neither.
                    Without the second half the same drop offered copying or not depending on the
                    drag-and-drop preference alone. */}
                {(capabilities.copy || pendingDrop?.kind === "transfer") && <ContextMenuItem icon={IconCopy} label={t("servers.fileManager.contextMenu.copyHere")} onClick={() => handleDropAction("copy")} />}
            </ContextMenu>
        </div>
    );
};


import React, { memo, useState, useContext } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import { EllipsisVertical as IconEllipsisVertical, Folder as IconFolder, Link as IconLink } from "lucide-react";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { getBaseUrl } from "@/common/utils/ConnectionUtil.js";
import {
    getExtension, getIconByFileEnding, getIconColor, convertUnits, isThumbnailSupported,
    formatPermissionsString, formatOctal,
} from "../../utils/fileUtils";
import { DEFAULT_CAPABILITIES } from "../../../../utils/paneCapabilities.js";
import { paneContentUrl } from "../../../../utils/paneEndpoint.js";
import { showsColumns, showsThumbnails } from "../../../../utils/viewModes.js";

export const FileItem = memo(({
                                  item,
                                  viewMode,
                                  path,
                                  session,
                                  isSelected,
                                  isFocused,
                                  isRenaming,
                                  isBeingDragged,
                                  isDropTarget,
                                  isCut,
                                  showThumbnails,
                                  highlight,
                                  renameValue,
                                  onRenameChange,
                                  onRenameKeyDown,
                                  onRenameBlur,
                                  onClick,
                                  onContextMenu,
                                  onDotsClick,
                                  onDragStart,
                                  onDragEnd,
                                  onDragOver,
                                  onDragLeave,
                                  onDrop,
                                  itemRef,
                                  capabilities = DEFAULT_CAPABILITIES,
                              }) => {
    const { t } = useTranslation();
    const { sessionToken } = useContext(UserContext);
    const [thumbnailError, setThumbnailError] = useState(false);

    const showThumbnailCandidate = showsThumbnails(viewMode) && showThumbnails && item.type === "file"
        && isThumbnailSupported(item.name) && !thumbnailError;

    const renderName = () => {
        const index = highlight ? item.name.toLowerCase().indexOf(highlight) : -1;
        if (index === -1) return item.name;
        return (
            <>
                {item.name.slice(0, index)}
                <span className="search-highlight">{item.name.slice(index, index + highlight.length)}</span>
                {item.name.slice(index + highlight.length)}
            </>
        );
    };

    // null when the session is unusable (paneContentUrl's contract, same as paneSocket). Folded
    // into canShowThumbnail below so an unusable pane falls back to the plain icon exactly like a
    // thumbnail that failed to load, instead of an <img> with no src.
    const fullPath = `${path.endsWith("/") ? path : path + "/"}${item.name}`;
    const thumbnailContentUrl = showThumbnailCandidate
        ? paneContentUrl(session, sessionToken, { path: encodeURIComponent(fullPath), thumbnail: true, size: 100 })
        : null;
    const canShowThumbnail = thumbnailContentUrl !== null;
    const thumbnailUrl = canShowThumbnail ? `${getBaseUrl()}${thumbnailContentUrl}` : null;

    const classNames = [
        "file-item",
        viewMode,
        isFocused && "focused",
        item.isSymlink && "symlink",
        canShowThumbnail && "has-thumbnail",
        isSelected && "selected",
        isRenaming && "renaming",
        isBeingDragged && "dragging",
        isDropTarget && "drop-target",
        isCut && "cut",
    ].filter(Boolean).join(" ");

    return (
        <div
            ref={itemRef}
            className={classNames}
            onClick={onClick}
            onContextMenu={onContextMenu}
            draggable={!isRenaming}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            tabIndex={0}
        >
            <div className="file-name">
                {canShowThumbnail ? (
                    <img
                        src={thumbnailUrl}
                        alt={item.name}
                        className="file-thumbnail"
                        loading="lazy"
                        onError={() => setThumbnailError(true)}
                    />
                ) : (
                    <Icon
                        icon={item.type === "folder" ? IconFolder : getIconByFileEnding(getExtension(item.name))}
                        style={{ color: getIconColor(item) }}
                    />
                )}
                {isRenaming ? (
                    <input
                        type="text"
                        className="rename-input"
                        value={renameValue}
                        onChange={onRenameChange}
                        onKeyDown={onRenameKeyDown}
                        onBlur={onRenameBlur}
                        onMouseDown={(e) => e.stopPropagation()}
                        autoFocus
                    />
                ) : (
                    <h2 title={item.name}>{renderName()}</h2>
                )}
                {item.isSymlink && <span className="symlink-badge"><Icon icon={IconLink} />{t("servers.fileManager.item.link")}</span>}
            </div>
            {showsColumns(viewMode) && (
                <>
                    <p className="file-size">{item.type === "file" && convertUnits(item.size)}</p>
                    {capabilities.nativeFs && (
                        <p className="file-permissions"
                           title={`${formatOctal(item.mode)} - ${formatPermissionsString(item.mode)}`}>
                            <span className="perms-text">{formatPermissionsString(item.mode)}</span>
                        </p>
                    )}
                    <p className="file-date">{new Date(item.last_modified * 1000).toLocaleDateString()}</p>
                </>
            )}
            <Icon
                icon={IconEllipsisVertical}
                className="dots-menu"
                onClick={onDotsClick}
            />
        </div>
    );
});
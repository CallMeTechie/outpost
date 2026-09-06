import "./styles.sass";
import { usePreferences } from "@/common/contexts/PreferencesContext.jsx";
import { useTranslation } from "react-i18next";
import { useContext } from "react";
import Icon from "@/common/components/Icon";
import { LayoutGrid as IconLayoutGrid, List as IconList, Rows3 as IconRows3, Image as IconImage, EyeOff as IconEyeOff, ShieldCheck as IconShieldCheck, Move as IconMove, Scissors as IconScissors, Copy as IconCopy, CircleQuestionMark as IconCircleQuestionMark, CloudSync as IconCloudSync, CloudOff as IconCloudOff } from "lucide-react";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import Button from "@/common/components/Button";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { VIEW_DETAILS, VIEW_COMPACT, VIEW_GRID, VIEW_MODES } from "@/pages/Servers/components/ViewContainer/renderer/FileRenderer/utils/viewModes.js";

// Same icon-per-mode map the action bar uses, so the two never end up drawing the
// same view with two different symbols.
const VIEW_MODE_ICONS = {
    [VIEW_DETAILS]: IconList,
    [VIEW_COMPACT]: IconRows3,
    [VIEW_GRID]: IconLayoutGrid,
};

const SettingItem = ({ icon, title, description, children }) => (
    <div className="setting-item">
        <div className="setting-info">
            {icon && (
                <div className="setting-icon">
                    <Icon icon={icon} size={0.9} />
                </div>
            )}
            <div className="setting-label">
                <h4>{title}</h4>
                <p>{description}</p>
            </div>
        </div>
        {children}
    </div>
);

const ViewOption = ({ icon, label, selected, onClick }) => (
    <div className={`view-option ${selected ? "selected" : ""}`} onClick={onClick}>
        <Icon icon={icon} size={0.9} />
        <span>{label}</span>
    </div>
);

export const FileManager = () => {
    const { t } = useTranslation();
    const { user } = useContext(UserContext);
    const { sendToast } = useToast();
    const { 
        showThumbnails, setShowThumbnails,
        defaultViewMode, setDefaultViewMode,
        showHiddenFiles, setShowHiddenFiles,
        confirmBeforeDelete, setConfirmBeforeDelete,
        dragDropAction, setDragDropAction,
        isGroupSynced, toggleGroupSync,
    } = usePreferences();

    const isFilesSynced = isGroupSynced("files");

    const handleSyncToggle = () => {
        if (!user) {
            sendToast(t("common.error"), t("settings.fileManager.syncLoginRequired"));
            return;
        }
        toggleGroupSync("files");
        sendToast(
            t("common.success"), 
            isFilesSynced ? t("settings.fileManager.syncDisabled") : t("settings.fileManager.syncEnabled")
        );
    };

    return (
        <div className="file-manager-settings">
            <div className="settings-section">
                <div className="section-header">
                    <h2>{t("settings.fileManager.title")}</h2>
                    <Button
                        icon={isFilesSynced ? IconCloudSync : IconCloudOff}
                        onClick={handleSyncToggle}
                        type={isFilesSynced ? "primary" : undefined}
                    />
                </div>
                <p>{t("settings.fileManager.description")}</p>

                <SettingItem 
                    icon={IconLayoutGrid}
                    title={t("settings.fileManager.defaultView.title")} 
                    description={t("settings.fileManager.defaultView.description")}
                >
                    <div className="view-options three-options">
                        {VIEW_MODES.map((mode) => (
                            <ViewOption
                                key={mode}
                                icon={VIEW_MODE_ICONS[mode]}
                                label={t(`servers.fileManager.viewMode.${mode}`)}
                                selected={defaultViewMode === mode}
                                onClick={() => setDefaultViewMode(mode)}
                            />
                        ))}
                    </div>
                </SettingItem>

                <SettingItem 
                    icon={IconImage}
                    title={t("settings.fileManager.thumbnails.title")} 
                    description={t("settings.fileManager.thumbnails.description")}
                >
                    <ToggleSwitch 
                        id="show-thumbnails" 
                        checked={showThumbnails} 
                        onChange={setShowThumbnails} 
                    />
                </SettingItem>

                <SettingItem 
                    icon={IconEyeOff}
                    title={t("settings.fileManager.hiddenFiles.title")} 
                    description={t("settings.fileManager.hiddenFiles.description")}
                >
                    <ToggleSwitch 
                        id="show-hidden-files" 
                        checked={showHiddenFiles} 
                        onChange={setShowHiddenFiles} 
                    />
                </SettingItem>

                <SettingItem 
                    icon={IconShieldCheck}
                    title={t("settings.fileManager.deleteConfirmation.title")} 
                    description={t("settings.fileManager.deleteConfirmation.description")}
                >
                    <ToggleSwitch 
                        id="confirm-before-delete" 
                        checked={confirmBeforeDelete} 
                        onChange={setConfirmBeforeDelete} 
                    />
                </SettingItem>

                <SettingItem 
                    icon={IconMove}
                    title={t("settings.fileManager.dragDropAction.title")} 
                    description={t("settings.fileManager.dragDropAction.description")}
                >
                    <div className="view-options three-options">
                        <ViewOption 
                            icon={IconScissors} 
                            label={t("settings.fileManager.dragDropAction.move")} 
                            selected={dragDropAction === "move"}
                            onClick={() => setDragDropAction("move")}
                        />
                        <ViewOption 
                            icon={IconCopy} 
                            label={t("settings.fileManager.dragDropAction.copy")} 
                            selected={dragDropAction === "copy"}
                            onClick={() => setDragDropAction("copy")}
                        />
                        <ViewOption 
                            icon={IconCircleQuestionMark} 
                            label={t("settings.fileManager.dragDropAction.ask")} 
                            selected={dragDropAction === "ask"}
                            onClick={() => setDragDropAction("ask")}
                        />
                    </div>
                </SettingItem>
            </div>
        </div>
    );
};

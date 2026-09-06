import "./styles.sass";
import { useTranslation } from "react-i18next";
import Icon from "@/common/components/Icon";
import { CloudDownload as IconCloudDownload, Pencil as IconPencil, Trash as IconTrash } from "lucide-react";

export const ThemeCard = ({ theme, isActive, onToggle, onEdit, onDelete, canEdit }) => {
    const { t } = useTranslation();
    return (
        <div
            className={`css-theme-card ${isActive ? "active" : ""}`}
            onClick={onToggle}
        >
            <div className="css-theme-card-top">
                <div className="css-theme-card-info">
                    <h4>{theme.name}</h4>
                    {theme.description && <p className="css-theme-card-desc">{theme.description}</p>}
                </div>
                <div className="css-theme-card-badges">
                    {theme.sourceId && (
                        <span className="source-badge" title={t("settings.account.customThemes.fromSource")}>
                            <Icon icon={IconCloudDownload} size={0.5} />
                        </span>
                    )}
                </div>
            </div>
            {canEdit && (
                <div className="css-theme-card-actions" onClick={(e) => e.stopPropagation()}>
                    {onEdit && (
                        <button className="action-btn" onClick={onEdit} title={t("settings.account.customThemes.edit")}>
                            <Icon icon={IconPencil} size={0.55} />
                        </button>
                    )}
                    {onDelete && (
                        <button className="action-btn delete-btn" onClick={onDelete} title={t("settings.account.customThemes.delete")}>
                            <Icon icon={IconTrash} size={0.55} />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

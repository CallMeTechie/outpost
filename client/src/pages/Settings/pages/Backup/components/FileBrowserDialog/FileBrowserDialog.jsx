import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import Icon from "@/common/components/Icon";
import { Download as IconDownload, Trash as IconTrash, LoaderCircle as IconLoaderCircle, FileText as IconFileText, Video as IconVideo } from "lucide-react";
import { getRequest, deleteRequest, downloadFile } from "@/common/utils/RequestUtil.js";
import { formatBytes, formatDate } from "@/common/utils/formatUtils.js";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import "./styles.sass";

export const FileBrowserDialog = ({ open, onClose, type, onFilesChanged }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [deleting, setDeleting] = useState(null);
    const [hasChanges, setHasChanges] = useState(false);

    const loadFiles = async () => {
        setLoading(true);
        try {
            const data = await getRequest(`backup/files/${type}`);
            setFiles(data);
        } catch {
            sendToast(t("common.error"), t("settings.backup.errors.loadFailed"));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (open) {
            setHasChanges(false);
            loadFiles();
        }
    }, [open, type]);

    const handleDownload = (filename) => {
        downloadFile(`backup/export/${type}/${encodeURIComponent(filename)}`);
    };

    const handleDelete = async (filename) => {
        setDeleting(filename);
        try {
            await deleteRequest(`backup/files/${type}/${encodeURIComponent(filename)}`);
            setFiles(prev => prev.filter(f => f.name !== filename));
            setHasChanges(true);
        } catch {
            sendToast(t("common.error"), t("settings.backup.errors.deleteFailed"));
        } finally {
            setDeleting(null);
        }
    };

    const handleClose = () => {
        if (hasChanges) onFilesChanged?.();
        onClose();
    };

    const icon = type === "recordings" ? IconVideo : IconFileText;
    const title = type === "recordings" ? t("settings.backup.storage.recordings") : t("settings.backup.storage.logs");

    return (
        <DialogProvider open={open} onClose={handleClose}>
            <div className="file-browser-dialog">
                <h2>{title}</h2>
                <div className="fb-list">
                    {loading ? (
                        <div className="fb-loading">
                            <Icon icon={IconLoaderCircle} spin size={1} />
                            <span>{t("settings.backup.loading")}</span>
                        </div>
                    ) : files.length === 0 ? (
                        <div className="fb-empty">
                            <Icon icon={icon} size={1.5} />
                            <span>{t("settings.backup.noFiles")}</span>
                        </div>
                    ) : (
                        files.map((file) => (
                            <div key={file.name} className="fb-item">
                                <div className="fb-info">
                                    <Icon icon={icon} className="fb-icon" />
                                    <div className="fb-details">
                                        <span className="fb-name">{file.name}</span>
                                        <span className="fb-meta">{formatBytes(file.size)} • {formatDate(file.modified)}</span>
                                    </div>
                                </div>
                                <div className="fb-actions">
                                    <Button icon={IconDownload} onClick={() => handleDownload(file.name)} type="secondary" />
                                    <Button 
                                        icon={deleting === file.name ? IconLoaderCircle : IconTrash} 
                                        onClick={() => handleDelete(file.name)} 
                                        type="secondary" 
                                        disabled={deleting === file.name}
                                    />
                                </div>
                            </div>
                        ))
                    )}
                </div>
                <div className="fb-dialog-actions">
                    <Button text={t("common.actions.close")} onClick={handleClose} type="secondary" />
                </div>
            </div>
        </DialogProvider>
    );
};

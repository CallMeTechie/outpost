import { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { getBaseUrl } from "@/common/utils/ConnectionUtil.js";
import { isTauri } from "@/common/utils/TauriUtil.js";
import { tauriDownload } from "@/common/utils/RequestUtil.js";
import Icon from "@mdi/react";
import { mdiImage, mdiFileDownload } from "@mdi/js";
import FloatingWindow, { FloatingWindowAction } from "@/common/components/FloatingWindow";
import { paneContentUrl, panePreviewUrl } from
    "@/pages/Servers/components/ViewContainer/renderer/FileRenderer/utils/paneEndpoint.js";
import { postRequest } from "@/common/utils/RequestUtil.js";
import "./styles.sass";

export const FilePreviewWindow = ({ file, session, onClose }) => {
    const { t } = useTranslation();
    const { sessionToken } = useContext(UserContext);
    const { sendToast } = useToast();
    const [fileUrl, setFileUrl] = useState(null);
    const [fileType, setFileType] = useState(null);
    // html only: the address that carries its credential in the path, so the page's own images
    // and stylesheets resolve. Null until the token is back, and null for any provider without
    // such a route -- the render falls back to "cannot preview" rather than to a broken frame.
    const [htmlUrl, setHtmlUrl] = useState(null);

    useEffect(() => {
        if (!file) {
            setFileUrl(null);
            setFileType(null);
            return;
        }

        const contentUrl = paneContentUrl(session, sessionToken, { path: file, preview: true });
        if (contentUrl === null) {
            // Same shape as the file manager's own unusable-session message: better a toast here
            // than an <img>/<video>/<iframe> pointed at no address at all.
            setFileUrl(null);
            setFileType(null);
            sendToast(t("common.error"), t("servers.fileManager.error.unusableSession"));
            return;
        }

        const extension = file.split(".").pop()?.toLowerCase();
        setFileUrl(`${getBaseUrl()}${contentUrl}`);

        const typeMap = {
            image: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"],
            video: ["mp4", "webm", "ogg", "mov"],
            audio: ["mp3", "wav", "ogg", "flac", "m4a"],
            pdf: ["pdf"],
            html: ["html", "htm"],
        };
        setFileType(Object.entries(typeMap).find(([, exts]) => exts.includes(extension))?.[0] || "unknown");
    }, [file, session, sessionToken, sendToast, t]);

    // A token per opened file rather than one kept alive: they last minutes, and a preview window
    // that sat open overnight should ask again rather than hold a credential all night.
    useEffect(() => {
        if (fileType !== "html" || !file || !session?.id) {
            setHtmlUrl(null);
            return;
        }

        let cancelled = false;
        // sessionToken goes in the query, not a header: /api/entries/sftp is mounted without the
        // authenticate middleware (server/index.js), and every route under it reads it from there.
        postRequest(`entries/sftp/preview-token?sessionId=${encodeURIComponent(session.id)}`
            + `&sessionToken=${encodeURIComponent(sessionToken)}`)
            .then((data) => {
                if (cancelled) return;
                const url = panePreviewUrl(session, data?.token, file);
                setHtmlUrl(url ? `${getBaseUrl()}${url}` : null);
            })
            .catch(() => {
                if (!cancelled) setHtmlUrl(null);
            });

        return () => { cancelled = true; };
    }, [fileType, file, session, sessionToken]);

    const downloadFile = async () => {
        if (fileUrl === null) {
            sendToast(t("common.error"), t("servers.fileManager.error.unusableSession"));
            return;
        }
        const fileName = file.split("/").pop();
        if (isTauri()) {
            try {
                await tauriDownload(fileUrl, fileName);
                sendToast(t("common.success"), t("servers.fileManager.toast.downloaded", { name: fileName }));
            } catch (e) {
                if (e) sendToast(t("common.error"), e.message);
            }
            return;
        }
        const link = document.createElement("a");
        link.href = fileUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const renderPreview = () => {
        switch (fileType) {
            case "image":
                return (
                    <div className="preview-content image-preview">
                        <img src={fileUrl} alt={file} />
                    </div>
                );
            case "video":
                return (
                    <div className="preview-content video-preview">
                        <video controls src={fileUrl}>
                            {t("servers.fileManager.filePreview.videoNotSupported")}
                        </video>
                    </div>
                );
            case "audio":
                return (
                    <div className="preview-content audio-preview">
                        <Icon path={mdiImage} size={3} />
                        <h3>{file.split("/").pop()}</h3>
                        <audio controls src={fileUrl}>
                            {t("servers.fileManager.filePreview.audioNotSupported")}
                        </audio>
                    </div>
                );
            case "pdf":
                return (
                    <div className="preview-content pdf-preview">
                        <iframe src={fileUrl} title={file} />
                    </div>
                );
            case "html":
                if (!htmlUrl) {
                    return (
                        <div className="preview-content unknown-preview">
                            <Icon path={mdiImage} size={3} />
                            <h3>{t("servers.fileManager.filePreview.loading")}</h3>
                            <p>{file.split("/").pop()}</p>
                        </div>
                    );
                }
                return (
                    <div className="preview-content html-preview">
                        {/* Sandboxed: the page may run its own scripts so a mockup behaves like a
                            mockup, but allow-same-origin is deliberately absent, so it cannot read
                            this app's storage or cookies. */}
                        <iframe src={htmlUrl} title={file} sandbox="allow-scripts allow-forms allow-popups" />
                    </div>
                );
            default:
                return (
                    <div className="preview-content unknown-preview">
                        <Icon path={mdiImage} size={3} />
                        <h3>{t("servers.fileManager.filePreview.cannotPreview")}</h3>
                        <p>{file.split("/").pop()}</p>
                    </div>
                );
        }
    };

    if (!file) return null;

    return (
        <FloatingWindow
            className="file-preview-window"
            icon={mdiImage}
            title={file.split("/").pop()}
            onClose={onClose}
            actions={
                <FloatingWindowAction onClick={downloadFile} title={t("common.download")}>
                    <Icon path={mdiFileDownload} />
                </FloatingWindowAction>
            }
        >
            {renderPreview()}
        </FloatingWindow>
    );
};

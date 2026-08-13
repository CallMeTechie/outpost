import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { usePreferences } from "@/common/contexts/PreferencesContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { downloadRequest, uploadFile } from "@/common/utils/RequestUtil.js";
import { ActionConfirmDialog } from "@/common/components/ActionConfirmDialog/ActionConfirmDialog.jsx";
import { DialogProvider } from "@/common/components/Dialog";
import Button from "@/common/components/Button";
import { paneContentUrl } from
    "@/pages/Servers/components/ViewContainer/renderer/FileRenderer/utils/paneEndpoint.js";
import Editor, { loader } from "@monaco-editor/react";
import Icon from "@mdi/react";
import { mdiContentSave, mdiTextBox } from "@mdi/js";
import FloatingWindow, { FloatingWindowAction } from "@/common/components/FloatingWindow";
import "./styles.sass";
import * as monaco from "monaco-editor";

loader.config({ monaco });

const normalizeFilename = (filename) => filename?.toLowerCase() || "";

const getMonacoLanguage = (filename) => {
    const name = normalizeFilename(filename);
    if (!name) return "plaintext";

    const basename = name.split("/").pop() || "";

    const exactNameMap = {
        "dockerfile": "dockerfile",
        "makefile": "makefile",
        ".env": "ini",
    };

    if (exactNameMap[basename]) return exactNameMap[basename];

    const extension = basename.includes(".") ? basename.split(".").pop() : "";

    const extensionMap = {
        js: "javascript",
        mjs: "javascript",
        cjs: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        json: "json",
        html: "html",
        htm: "html",
        css: "css",
        scss: "scss",
        sass: "scss",
        less: "less",
        md: "markdown",
        markdown: "markdown",
        yml: "yaml",
        yaml: "yaml",
        xml: "xml",
        sh: "shell",
        bash: "shell",
        zsh: "shell",
        py: "python",
        go: "go",
        java: "java",
        c: "c",
        h: "c",
        cpp: "cpp",
        cc: "cpp",
        cxx: "cpp",
        hpp: "cpp",
        hxx: "cpp",
        cs: "csharp",
        php: "php",
        rb: "ruby",
        rs: "rust",
        swift: "swift",
        kt: "kotlin",
        kts: "kotlin",
        sql: "sql",
        gql: "graphql",
        graphql: "graphql",
        toml: "toml",
        ini: "ini",
        conf: "ini",
        env: "ini",
        txt: "plaintext",
    };

    return extensionMap[extension] || "plaintext";
};

export const FileEditorWindow = ({ file, session, onClose }) => {
    const { t } = useTranslation();
    const { theme } = usePreferences();
    const { sessionToken } = useContext(UserContext);
    const { sendToast } = useToast();
    const [fileContent, setFileContent] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [fileContentChanged, setFileContentChanged] = useState(false);
    const [unsavedChangesDialog, setUnsavedChangesDialog] = useState(false);
    const [conflictDialog, setConflictDialog] = useState(false);
    const [saving, setSaving] = useState(false);
    const [language, setLanguage] = useState("plaintext");
    // A ref, not state: nothing on screen depends on it, and it has to survive a save handler that
    // reads it well after the render that set it. Stays null for a server session — there is no
    // ETag to put here, so the header below never gets built and the 412 branch never has anything
    // to fire on. That absence, not a feature flag, is the whole reason an SFTP save is unchanged.
    const etagRef = useRef(null);

    // Pulled out of the load effect so the conflict dialog's "discard mine and reload" can run the
    // exact same fetch a fresh open would have, tag included.
    const loadFile = useCallback(() => {
        if (!file) return;
        setIsLoading(true);
        setFileContent("");
        setFileContentChanged(false);
        setLanguage(getMonacoLanguage(file));
        etagRef.current = null;

        const url = paneContentUrl(session, sessionToken, { path: file });
        if (url === null) {
            setIsLoading(false);
            sendToast(t("common.error"), t("servers.fileManager.error.unusableSession"));
            return;
        }

        downloadRequest(url, { onHeaders: (headers) => { etagRef.current = headers.get("etag"); } })
            .then((res) => {
                const reader = new FileReader();
                reader.onload = () => {
                    setFileContent(reader.result);
                    setIsLoading(false);
                };
                reader.readAsText(res);
            })
            .catch(() => {
                setIsLoading(false);
            });
    }, [file, session, sessionToken, sendToast, t]);

    useEffect(() => {
        loadFile();
    }, [loadFile]);

    // `force` skips the condition entirely rather than sending a stale one — this is what "overwrite
    // with my version" from the conflict dialog calls, and it must not just retry the same If-Match
    // that Graph already rejected.
    const saveFile = async (force = false) => {
        setSaving(true);
        try {
            const url = paneContentUrl(session, sessionToken, { path: encodeURIComponent(file), upload: true });
            if (url === null) throw new Error(t("servers.fileManager.error.unusableSession"));

            const blob = new Blob([fileContent], { type: "application/octet-stream" });
            const headers = {};
            // A tag ever having been read is what marks this as a session worth guarding at all —
            // true for OneDrive, forever false for a server, whether or not THIS particular save
            // happens to carry a condition. X-Return-Etag is what asks the route to spend its extra
            // stat; leaving it off is what keeps an ordinary drag-and-drop upload (which never sets
            // it) from paying for a round trip nobody there would ever read.
            if (etagRef.current) headers["X-Return-Etag"] = "true";
            if (!force && etagRef.current) headers["If-Match"] = etagRef.current;

            const result = await uploadFile(url, blob, { headers });
            // The tag this save just produced. Skipping this is the trap the brief warns about:
            // the next save would still carry the tag from before this write, OneDrive would see it
            // as stale all over again, and "overwrite" would turn into a loop the user cannot escape.
            if (typeof result?.etag === "string") etagRef.current = result.etag;

            setFileContentChanged(false);
            sendToast(t("common.success"), t("servers.fileManager.fileEditor.saveSuccess"));
        } catch (err) {
            if (err.status === 412) {
                setConflictDialog(true);
            } else {
                sendToast(t("common.error"), err.message || t("servers.fileManager.fileEditor.saveFailed"));
            }
        } finally {
            setSaving(false);
        }
    };

    const overwriteConflict = () => {
        setConflictDialog(false);
        saveFile(true);
    };

    const reloadConflict = () => {
        setConflictDialog(false);
        loadFile();
    };

    const closeFile = () => fileContentChanged ? setUnsavedChangesDialog(true) : onClose();

    const updateContent = (value) => {
        setFileContentChanged(true);
        setFileContent(value);
    };

    if (!file) return null;

    return (
        <>
            <ActionConfirmDialog
                text={t("servers.fileManager.fileEditor.unsavedChanges")}
                onConfirm={onClose}
                open={unsavedChangesDialog}
                setOpen={setUnsavedChangesDialog}
            />

            {/* No merge, per the spec: the only two ways out are keep mine or take theirs. disableClosing
                keeps a stray click or Escape from leaving the question unanswered. */}
            <DialogProvider open={conflictDialog} disableClosing>
                <div className="conflict-dialog">
                    <h3>{t("servers.fileManager.fileEditor.conflictTitle")}</h3>
                    <p>{t("servers.fileManager.fileEditor.conflictBody")}</p>
                    <div className="conflict-actions">
                        <Button onClick={reloadConflict} type="secondary"
                                text={t("servers.fileManager.fileEditor.conflictReload")} />
                        <Button onClick={overwriteConflict} type="primary"
                                text={t("servers.fileManager.fileEditor.conflictOverwrite")} />
                    </div>
                </div>
            </DialogProvider>

            <FloatingWindow
                className="file-editor-window"
                icon={mdiTextBox}
                title={file.split("/").pop()}
                titleExtra={fileContentChanged && <span className="modified-indicator">●</span>}
                onClose={closeFile}
                actions={
                    <FloatingWindowAction onClick={() => saveFile()}
                            disabled={!fileContentChanged || saving} title={t("common.save")}>
                        <Icon path={mdiContentSave} />
                    </FloatingWindowAction>
                }
            >
                <div className="file-editor-content">
                    {isLoading ? (
                        <div className="file-editor-loading">
                            <div className="loading-spinner" />
                            <span>{t("servers.fileManager.fileEditor.loading")}</span>
                        </div>
                    ) : (
                        <Editor
                            value={fileContent}
                            onChange={updateContent}
                            language={language}
                            theme={theme === "dark" || theme === "oled" ? "vs-dark" : "vs-light"}
                            options={{
                                minimap: { enabled: false },
                                fontSize: 14,
                                lineNumbers: "on",
                                scrollBeyondLastLine: false,
                                automaticLayout: true,
                                wordWrap: "off",
                                tabSize: 4,
                                insertSpaces: true,
                            }}
                        />
                    )}
                </div>
            </FloatingWindow>
        </>
    );
};

// The pure header/name rules a single-file download needs, plus the thin wiring that turns a
// path into a streamed response. Both providers share this: the sftp client and the Graph
// adapter answer stat and readFile alike, through the same eight-method seam archive.js uses.
const logger = require("../../utils/logger");

const THUMB_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
const MAX_THUMB_SIZE = 10 * 1024 * 1024;
const MIME_TYPES = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4",
    webm: "video/webm", mp3: "audio/mpeg", txt: "text/plain", json: "application/json",
    html: "text/html", css: "text/css", js: "application/javascript",
};

const getExt = (p) => p.split(".").pop()?.toLowerCase();
const getFileName = (p) => p.split("/").pop();
const sanitizeFileName = (name) => name.replaceAll(/[^\w\s.-]/g, "_").substring(0, 255);

const clampThumbSize = (size) => Math.min(Math.max(Number.parseInt(size) || 100, 50), 300);

const contentHeaders = ({ fileName, size, ext, preview }) => {
    const disposition = preview ? "inline" : "attachment";
    const safeFileName = sanitizeFileName(fileName);
    const headers = {
        "Content-Disposition": `${disposition}; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Content-Length": size,
    };
    // An unknown extension gets no Content-Type at all, rather than a guessed one.
    if (MIME_TYPES[ext]) headers["Content-Type"] = MIME_TYPES[ext];
    return headers;
};

const sendFile = async (adapter, res, path, { preview } = {}) => {
    const stats = await adapter.stat(path);
    const headers = contentHeaders({ fileName: getFileName(path), size: stats.size, ext: getExt(path), preview });
    for (const [name, value] of Object.entries(headers)) res.header(name, value);

    const { stream } = adapter.readFile(path);
    // A stream error after headers are already on the wire cannot change the status code — the
    // best this can do is stop the response from staying open and stop the stream from leaking.
    stream.on("error", (err) => {
        logger.warn("Download stream error", { error: err.message, path });
        if (!res.headersSent) res.status(500).end();
    });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
};

module.exports = {
    MIME_TYPES, THUMB_EXTS, MAX_THUMB_SIZE,
    getExt, getFileName, sanitizeFileName, clampThumbSize, contentHeaders, sendFile,
};

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

// The caller already has stats by the time it gets here — sftp.js's download branch stats once
// and reuses it for the folder check, the thumbnail size gate and the headers. Statting again
// here would cost the Graph adapter a second round trip, and open a window for the file to
// change between the two calls. So sendFile takes no stat of its own and sets no headers — it is
// pure streaming; the caller builds the headers from the stats it already has.
const sendFile = async (adapter, res, path) => {
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

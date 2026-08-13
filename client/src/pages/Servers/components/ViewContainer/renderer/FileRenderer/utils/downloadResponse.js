// Shared by downloadFile and downloadMultipleFiles: both fetch a content route and save the
// result as a blob instead of linking to it directly, specifically so a non-200 response —
// Microsoft's or sftp.js's own JSON error body — surfaces as a thrown Error instead of being
// saved to disk under the file's own name (see FileList.jsx's own note on this exact trap). Pure
// and DOM-free on purpose: this is the part worth pinning with a node:test — createObjectURL and
// the anchor click that actually save the blob are not, and stay in FileRenderer.jsx.

// response.json() throws on a body that is not JSON at all (an empty body, an upstream proxy's
// HTML error page); that case still needs a message, so it falls back the same as a JSON body
// with no `error` field does.
export const readErrorMessage = async (response, fallbackMessage) => {
    const body = await response.json().catch(() => null);
    return body?.error || fallbackMessage;
};

// The server names an archive (or an editor's re-saved file) itself — routes/sftp.js and
// routes/oneDriveContent.js both set Content-Disposition. fallbackFileName is what the caller
// already knows locally (the path it asked for, or a Tauri-only default), so a response with no
// header, or one neither regex below can parse, still leaves the caller with a name to save under.

// RFC 5987 ext-value: charset'lang'percent-encoded-value. download.js's contentHeaders always
// sends UTF-8 with an empty lang, but the lang tag is legal (filename*=UTF-8'de'name) and some
// other emitter down the line could set it, so both forms need to parse.
const EXTENDED_FILENAME = /filename\*\s*=\s*([^']*)'([^']*)'([^;]+)/i;
// Sanitized, ASCII-only fallback (see sanitizeFileName in download.js) — the only form the ZIP
// routes ever send, since they never set filename* at all.
const QUOTED_FILENAME = /filename="?([^"]+)"?/;

export const fileNameFromDisposition = (response, fallbackFileName) => {
    const disposition = response.headers.get("content-disposition") || "";
    const extended = disposition.match(EXTENDED_FILENAME);
    if (extended && /^utf-8$/i.test(extended[1])) {
        const encoded = extended[3].trim();
        // A value this function cannot decode (malformed percent-encoding) is not proof the header
        // lied about the name — use it as-is rather than throwing out of a helper callers reach in
        // the middle of an otherwise successful download.
        try {
            return decodeURIComponent(encoded);
        } catch {
            return encoded;
        }
    }
    return disposition.match(QUOTED_FILENAME)?.[1] || fallbackFileName;
};

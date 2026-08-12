const { PassThrough, Readable } = require("node:stream");
const { GraphError } = require("./graphErrors");
const { uploadLarge, SIMPLE_UPLOAD_LIMIT } = require("./oneDriveUpload");

const PAGE_SIZE = 200;

// Fifty pages of two hundred is ten thousand items. Beyond that listDir fails rather than
// truncates: a folder walk that silently skipped the rest would move what it saw and then delete
// a source folder it never fully read.
const MAX_PAGES = 50;

const SELECT = "name,size,lastModifiedDateTime,folder,file";

// ":" and "\" break Graph's path addressing itself, control characters have no business in a name,
// and "." / ".." never name a real OneDrive item — forwarding them would hand path traversal to
// whoever supplies the path.
//
// Written with escapes on purpose: literal control bytes in the source make git treat the whole
// file as binary, and a diff nobody can read is a file nobody can review. \x7f (DEL) is included
// for the same reason the tmux helpers include it.
const UNUSABLE_SEGMENT = /[:\\]|[\x00-\x1f\x7f]/;

const splitPath = (path) => {
    // Coercing would turn a caller's undefined into the drive root — and Task 5 uses these same
    // helpers for delete and move, where silently addressing the root is the worst possible guess.
    if (typeof path !== "string") throw new GraphError(`Invalid OneDrive path: ${String(path)}`);

    const segments = path.split("/").filter((segment) => segment.length > 0);

    for (const segment of segments) {
        if (segment === "." || segment === ".." || UNUSABLE_SEGMENT.test(segment)) {
            throw new GraphError(`Invalid OneDrive path: ${path}`);
        }
    }

    return segments;
};

const encodeSegments = (segments) => segments.map(encodeURIComponent).join("/");

const itemUrl = (path) => {
    const segments = splitPath(path);
    return segments.length === 0 ? "/root" : `/root:/${encodeSegments(segments)}:`;
};

const childrenUrl = (path) => {
    const segments = splitPath(path);
    return segments.length === 0 ? "/root/children" : `/root:/${encodeSegments(segments)}:/children`;
};

// The SFTP adapter reports epoch seconds; Graph reports ISO-8601. Converted here so that everything
// above the seam sees one shape whichever side it is talking to.
const toEpochSeconds = (value) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
};

const mapItem = (item) => ({
    name: item.name,
    type: item.folder ? "folder" : "file",
    size: Number.isInteger(item.size) ? item.size : 0,
    mtime: toEpochSeconds(item.lastModifiedDateTime),
    // OneDrive has no symbolic links. The field is reported so that the walk can read the same
    // shape from either adapter.
    isSymlink: false,
});

const createOneDriveAdapter = ({ graph, connectionId }) => {
    const listDir = async (path) => {
        const entries = [];
        let url = `${childrenUrl(path)}?$select=${SELECT}&$top=${PAGE_SIZE}`;

        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const { body } = await graph.request(connectionId, { url });

            // A missing `value` means the answer was not a readable listing — graphClient turns any
            // body it cannot parse into null. Treating that as "empty" would let rmdir(path, false)
            // delete a folder it never actually looked into, and that runs on the SOURCE side of a
            // move: "I could not read the answer" would become "delete the user's original".
            if (!Array.isArray(body?.value)) throw new GraphError("OneDrive returned an unreadable folder listing");

            for (const item of body.value) entries.push(mapItem(item));

            const next = body?.["@odata.nextLink"];
            if (typeof next !== "string") return entries;

            url = next;
        }

        throw new GraphError(`This OneDrive folder holds more than ${MAX_PAGES * PAGE_SIZE} items`);
    };

    const stat = async (path) => {
        const { body } = await graph.request(connectionId, { url: `${itemUrl(path)}?$select=${SELECT}` });
        const mapped = mapItem(body ?? {});

        return { size: mapped.size, type: mapped.type, mtime: mapped.mtime, isSymlink: false };
    };

    const readFile = (path) => {
        const stream = new PassThrough();

        let settleDone;
        let failDone;
        const done = new Promise((resolve, reject) => { settleDone = resolve; failDone = reject; });

        stream.on("end", () => settleDone());
        stream.on("error", (error) => failDone(error));

        // FileTransfer cancels by destroying the stream it was handed — it has no notion of an
        // AbortSignal. Turning that destroy into an abort is what makes a cancel reach the running
        // request instead of leaving the download to finish quietly in the background. A stream
        // that ended on its own is not a cancel, which is what readableEnded tells apart.
        const controller = new AbortController();
        stream.on("close", () => {
            if (stream.readableEnded) return;
            controller.abort();
            failDone(new GraphError("The OneDrive read was cancelled"));
        });

        // Graph answers with a redirect to pre-authenticated storage and fetch follows it, so the
        // body is a web ReadableStream while everything above expects a Node stream. The throttled
        // part is the request itself, which is over before a single byte flows — that is why the
        // backoff rule of the upload path has no counterpart here.
        graph.request(connectionId, { url: `${itemUrl(path)}/content`, parse: "raw", signal: controller.signal })
            .then((response) => {
                // An empty file comes back without a body. Handing null to Readable.fromWeb throws
                // a TypeError, and a zero byte file is a perfectly ordinary thing to transfer.
                if (!response.body) {
                    stream.end();
                    return;
                }

                Readable.fromWeb(response.body).pipe(stream);
            })
            .catch((error) => { stream.destroy(error); });

        return { stream, done };
    };

    // Bounded on purpose: the size is a promise from the caller, and a source that delivers more
    // than it promised must not be able to grow this buffer without end.
    const collect = async (source, size) => {
        const pieces = [];
        let total = 0;

        for await (const piece of source) {
            total += piece.length;
            // Bounded against what the caller promised, not against the 4 MiB ceiling: a source
            // that delivers a different amount than it announced would otherwise upload a file of
            // the wrong length with no complaint from this layer at all.
            if (total > size) throw new GraphError(`OneDrive expected ${size} bytes but the source delivered more`);
            pieces.push(piece);
        }

        if (total !== size) {
            throw new GraphError(`OneDrive expected ${size} bytes but the source delivered ${total}`);
        }

        return Buffer.concat(pieces, total);
    };

    const writeFile = async (path, source, options = {}) => {
        const size = Buffer.isBuffer(source) ? source.length : options.size;

        // Graph wants the total length in every chunk's Content-Range. Finding it out by buffering
        // the whole stream is exactly what the hint exists to avoid, so a missing hint is refused.
        if (!Number.isInteger(size) || size < 0) {
            throw new GraphError("OneDrive needs to know the file size before it can accept an upload");
        }

        const target = itemUrl(path);

        // The same idea as in readFile: FileTransfer cancels by destroying the source stream, and
        // that has to reach the request in flight — otherwise a cancelled upload keeps pushing
        // chunks at Microsoft until the file is complete. A source that ended on its own is not a
        // cancel, which is what readableEnded tells apart.
        const controller = new AbortController();
        if (typeof source?.on === "function") {
            source.on("error", () => controller.abort());
            source.on("close", () => { if (!source.readableEnded) controller.abort(); });
        }

        if (size <= SIMPLE_UPLOAD_LIMIT) {
            const payload = Buffer.isBuffer(source) ? source : await collect(source, size);

            await graph.request(connectionId, {
                url: `${target}/content`,
                method: "PUT",
                headers: { "Content-Type": "application/octet-stream" },
                body: payload,
                signal: controller.signal,
            });

            return;
        }

        await uploadLarge({
            graph, connectionId, itemPath: target, size, signal: controller.signal,
            // A Buffer is iterable byte by byte, so uploadLarge's `for await` would see numbers
            // instead of chunks and upload nothing at all. Wrapping keeps both kinds of source
            // honest on the large path.
            source: Buffer.isBuffer(source) ? Readable.from([source]) : source,
        });
    };

    const mkdirRecursive = async (path) => {
        const segments = splitPath(path);

        for (let level = 0; level < segments.length; level += 1) {
            try {
                await graph.request(connectionId, {
                    url: childrenUrl(segments.slice(0, level).join("/")),
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: segments[level],
                        folder: {},
                        "@microsoft.graph.conflictBehavior": "fail",
                    }),
                });
            } catch (error) {
                // Graph has no "create if missing". A name already taken is the normal case when
                // several files share a parent — but only that one conflict counts as success.
                // A 409 proves the name is taken, not that it names a folder. Verifying the type
                // would cost one extra request per already-existing level, on every transfer into
                // an existing tree. It is not worth it: FileTransfer stats every directory of the
                // plan itself and refuses a type conflict with the path in the message
                // (FileTransfer.js:286-289). Only levels created implicitly in between are exposed,
                // and there the next call fails with Graph's own error naming the same path.
                const alreadyThere = error?.status === 409
                    && (error.code === null || error.code === undefined || error.code === "nameAlreadyExists");

                if (!alreadyThere) throw error;
            }
        }
    };

    const unlink = async (path) => {
        try {
            await graph.request(connectionId, { url: itemUrl(path), method: "DELETE" });
        } catch (error) {
            // Already gone is the outcome the caller wanted.
            if (error?.status !== 404) throw error;
        }
    };

    const rmdir = async (path, recursive) => {
        // Strictly true, not merely truthy: anything else takes the branch that looks first, so a
        // caller passing "false" or an object fails closed rather than deleting a folder whole.
        if (recursive !== true) {
            // Graph always deletes a folder with its contents; there is no "only if empty". The
            // move cleanup path asks for this form precisely to be told that something is left.
            const remaining = await listDir(path);
            if (remaining.length > 0) throw new GraphError("This OneDrive folder is not empty");
        }

        await unlink(path);
    };

    const checksum = async () => {
        throw new GraphError("OneDrive does not provide a checksum this transfer can compare");
    };

    return {
        // No checksum: Microsoft reports SHA-256 for personal accounts and its own quickXorHash for
        // business ones, and the SSH side can only compute the former. A guarantee that holds for
        // some accounts and not others — invisibly — is worse than none where a move deletes the
        // source. _verifyAll still compares the size on every transfer.
        supportsChecksum: false,

        listDir,
        stat,
        readFile,
        writeFile,
        mkdirRecursive,
        unlink,
        rmdir,
        checksum,
    };
};

module.exports = { PAGE_SIZE, MAX_PAGES, createOneDriveAdapter, splitPath, itemUrl, childrenUrl };

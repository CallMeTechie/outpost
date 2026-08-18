const { PassThrough, Readable } = require("node:stream");
const { GraphError } = require("./graphErrors");
const { uploadLarge, SIMPLE_UPLOAD_LIMIT } = require("./oneDriveUpload");

const PAGE_SIZE = 200;

// Fifty pages of two hundred is ten thousand items. Beyond that listDir fails rather than
// truncates: a folder walk that silently skipped the rest would move what it saw and then delete
// a source folder it never fully read.
const MAX_PAGES = 50;

const SELECT = "name,size,lastModifiedDateTime,folder,file,cTag";

// Graph names its thumbnail sizes rather than accepting an arbitrary pixel count. Widths are the
// documented resolutions for the "longest edge" presets (small/medium/large) — the only three that
// are guaranteed to exist without Graph having to render a custom size on demand. Ordered ascending
// so pickThumbnailStep can stop at the first one wide enough.
const THUMBNAIL_STEPS = [
    ["small", 96],
    ["medium", 176],
    ["large", 800],
];

// The smallest step at least as wide as what was asked, never a smaller one: a browser can shrink
// a thumbnail that came back larger than requested, but it cannot invent detail an upscaled small
// one never had. A request wider than every step still gets an answer — the largest one available —
// rather than an error, since "the biggest OneDrive offers" is a reasonable thing to show.
const pickThumbnailStep = (size) => {
    for (const [name, width] of THUMBNAIL_STEPS) {
        if (size <= width) return name;
    }
    return THUMBNAIL_STEPS[THUMBNAIL_STEPS.length - 1][0];
};

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
    // Graph's change tag: it moves only when the item's CONTENT changes, unlike eTag, which also
    // moves on a rename, a move or a new share. This is the one place that decides which of
    // Graph's two tags the seam calls "cTag" — a future switch to eTag is a one-line change here
    // (and in SELECT above), not a hunt through every caller.
    cTag: typeof item.cTag === "string" ? item.cTag : null,
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

        // The same rule listDir follows, and for the same reason: graphClient turns a body it cannot
        // parse into null, and mapItem({}) answers with a zero-byte file. That answer is not
        // harmless — _verifyAll compares it against the plan and would pass a file nobody could
        // read, and a folder would come back as "target exists with a different type".
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            throw new GraphError("OneDrive returned an unreadable answer for this item");
        }

        const mapped = mapItem(body);

        return {
            size: mapped.size, type: mapped.type, mtime: mapped.mtime, isSymlink: false, cTag: mapped.cTag,
        };
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
        // body is a web ReadableStream while everything above expects a Node stream.
        //
        // The read side gets a tighter wait budget than the write side, and precisely because the
        // request is over before a single byte flows: that is exactly what makes FileTransfer's
        // pipeline read as EMPTY for the whole backoff, and an empty pipeline gets READ_STALL_TIMEOUT
        // (60 s) where a full one gets DEST_STALL_TIMEOUT (600 s). A Retry-After of 90 s is inside
        // the client's own 120 s ceiling and would be honoured correctly — and killed from above as
        // "Read stalled, transfer aborted". 45 s leaves room for the watchdog to be wrong about us.
        graph.request(connectionId, {
            url: `${itemUrl(path)}/content`,
            parse: "raw",
            signal: controller.signal,
            maxTotalWaitMs: 45_000,
        })
            .then((response) => {
                // An empty file comes back without a body. Handing null to Readable.fromWeb throws
                // a TypeError, and a zero byte file is a perfectly ordinary thing to transfer.
                if (!response.body) {
                    stream.end();
                    return;
                }

                const node = Readable.fromWeb(response.body);
                // pipe() attaches no error handler to its source. An aborted or dropped body would
                // otherwise emit 'error' with nobody listening, and an uncaught exception takes the
                // whole server down through errorHandling.js.
                node.on("error", (error) => stream.destroy(error));
                node.pipe(stream);
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

            // The one place an `ifMatch` option becomes the actual HTTP condition. Nothing above
            // this decides cTag vs eTag — that choice was already made where the tag was read (see
            // mapItem) — this line only forwards whatever the caller supplied, or sends no
            // condition at all when it did not. A stale tag makes Graph answer 412, which
            // graph.request turns into a GraphError carrying Microsoft's own message.
            const headers = { "Content-Type": "application/octet-stream" };
            if (typeof options.ifMatch === "string" && options.ifMatch !== "") headers["If-Match"] = options.ifMatch;

            await graph.request(connectionId, {
                url: `${target}/content`,
                method: "PUT",
                headers,
                body: payload,
                signal: controller.signal,
            });

            return;
        }

        // Graph's upload session CAN carry a condition of its own (an If-Match on session
        // creation), and that would be the better long-term answer for a large conditional write.
        // But nothing reachable from here can prove that header actually guards a real account —
        // the identical gap Step 1 named for cTag itself — and a condition that is silently
        // ignored is worse than no condition at all: it looks like protection and is not one. So a
        // caller asking for one on a file this size is told plainly, loudly, before a single byte
        // moves, rather than getting a passthrough nobody has verified. The editor this guard
        // exists for never reaches this branch — it only ever opens files under 1 MB, well inside
        // SIMPLE_UPLOAD_LIMIT — so this is a stated boundary, not a live limitation on anyone today.
        if (typeof options.ifMatch === "string" && options.ifMatch !== "") {
            throw new GraphError(
                `OneDrive cannot make a conditional write for a ${size} byte file — If-Match is `
                + "only supported at or under the simple-upload limit",
            );
        }

        await uploadLarge({
            graph, connectionId, itemPath: target, size, signal: controller.signal,
            // A Buffer is iterable byte by byte, so uploadLarge's `for await` would see numbers
            // instead of chunks and upload nothing at all. Wrapping keeps both kinds of source
            // honest on the large path.
            source: Buffer.isBuffer(source) ? Readable.from([source]) : source,
        });
    };

    // Graph names one thumbnail image "0" by convention — a custom uploaded thumbnail also takes
    // that index, and every item this route ever asks about has at most the one Graph generated.
    const THUMBNAIL_ID = "0";

    const thumbnail = async (path, size) => {
        const step = pickThumbnailStep(size);
        const { body } = await graph.request(connectionId, { url: `${itemUrl(path)}/thumbnails/${THUMBNAIL_ID}/${step}` });

        // A file with no bitmap representation — not an image, or a type Graph cannot preview —
        // answers this request with a body that carries no url just as often as it answers 404.
        // Both mean the same thing here, and both must reach the caller as a thrown error: the
        // route turns it into a 404 and the grid falls back to the file icon, the same as it does
        // for the SFTP side's thumbnail failures.
        if (body === null || typeof body !== "object" || typeof body.url !== "string") {
            throw new GraphError("OneDrive has no thumbnail for this item");
        }

        // The metadata call above answers with a URL into pre-authenticated storage, not the image
        // itself — fetched here and returned as bytes so a working, unauthenticated Microsoft
        // address never has to reach the client and sit in its browser history.
        const response = await graph.request(connectionId, { url: body.url, anonymous: true, parse: "raw" });
        const data = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers?.get?.("content-type") || "application/octet-stream";

        return { data, contentType };
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

    // Not part of the eight method seam — FileTransfer never renames. It exists for the pane, and
    // it is one PATCH rather than a copy and a delete.
    const rename = async (path, name) => {
        if (typeof name !== "string" || name === "" || name.includes("/") || name === "." || name === "..") {
            throw new GraphError(`Invalid OneDrive name: ${String(name)}`);
        }

        await graph.request(connectionId, {
            url: itemUrl(path),
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        });
    };

    // Graph addresses a parent folder by its own path syntax, and the root is the empty case again.
    const parentReference = (folder) => {
        const segments = splitPath(folder);
        return { path: segments.length === 0 ? "/drive/root:" : `/drive/root:/${encodeSegments(segments)}` };
    };

    // Microsoft moves the item itself: one PATCH, and not a byte through Outpost.
    const move = async (path, targetFolder) => {
        await graph.request(connectionId, {
            url: itemUrl(path),
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parentReference: parentReference(targetFolder) }),
        });
    };

    const MAX_COPY_POLLS = 60;

    // A copy is asynchronous: Graph answers 202 with a monitor url and finishes in its own time.
    // The url is pre-authenticated like an upload session, so it carries no token.
    const copy = async (path, targetFolder, { pollDelayMs = 1000 } = {}) => {
        const started = await graph.request(connectionId, {
            url: `${itemUrl(path)}/copy`,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parentReference: parentReference(targetFolder) }),
        });

        const monitor = started?.headers?.get?.("location");
        if (typeof monitor !== "string" || monitor === "") {
            throw new GraphError("OneDrive did not provide a monitor URL for this copy");
        }

        for (let poll = 0; poll < MAX_COPY_POLLS; poll += 1) {
            const { body } = await graph.request(connectionId, { url: monitor, anonymous: true });

            if (body?.status === "completed") return;
            if (body?.status === "failed") {
                throw new GraphError(`OneDrive could not copy the item: ${body?.error?.message ?? "no reason given"}`);
            }

            await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
        }

        throw new GraphError("The OneDrive copy did not finish in time");
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
        thumbnail,
        mkdirRecursive,
        unlink,
        rmdir,
        checksum,
        rename,
        move,
        copy,
    };
};

// splitPath, itemUrl and childrenUrl have no importer yet on purpose: the move and copy handlers of
// the next project address items by the same path syntax and will take them from here rather than
// build a second one.
module.exports = {
    PAGE_SIZE, MAX_PAGES, createOneDriveAdapter, splitPath, itemUrl, childrenUrl, pickThumbnailStep,
};

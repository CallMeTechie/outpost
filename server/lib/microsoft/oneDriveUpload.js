const { GraphError } = require("./graphErrors");

// Microsoft requires every chunk but the last to be a multiple of 320 KiB. 5 MiB is exactly
// sixteen of them and sits in the range Microsoft recommends.
const CHUNK_SIZE = 5 * 1024 * 1024;

// Above this a simple PUT would have to hold the whole body in memory, so the session takes over.
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

const openSession = async (graph, connectionId, itemPath, signal) => {
    const { body } = await graph.request(connectionId, {
        url: `${itemPath}/createUploadSession`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
        signal,
    });

    if (typeof body?.uploadUrl !== "string") throw new GraphError("OneDrive did not return an upload session");
    return body.uploadUrl;
};

// Best effort by design: the caller is already failing, and a session left behind only occupies
// Microsoft's storage for a few hours. It must never replace the error the caller is carrying.
const discardSession = async (graph, connectionId, uploadUrl) => {
    try {
        await graph.request(connectionId, { url: uploadUrl, method: "DELETE", anonymous: true });
    } catch {
        // deliberately swallowed — see above
    }
};

const uploadLarge = async ({ graph, connectionId, itemPath, source, size, signal }) => {
    const uploadUrl = await openSession(graph, connectionId, itemPath, signal);

    const queue = [];
    let queued = 0;
    let offset = 0;

    // Copies out of the queue without rebuilding it: concatenating on every piece would be
    // quadratic on a source that delivers in small frames, which the SFTP side does.
    const takeChunk = (wanted) => {
        const out = Buffer.allocUnsafe(wanted);
        let filled = 0;

        while (filled < wanted) {
            const head = queue[0];
            const room = wanted - filled;

            if (head.length <= room) {
                head.copy(out, filled);
                filled += head.length;
                queue.shift();
            } else {
                head.copy(out, filled, 0, room);
                queue[0] = head.subarray(room);
                filled = wanted;
            }
        }

        queued -= wanted;
        return out;
    };

    const putChunk = async (chunk) => {
        const last = offset + chunk.length - 1;

        const response = await graph.request(connectionId, {
            url: uploadUrl,
            method: "PUT",
            // No bearer token: the session URL is pre-authenticated, Microsoft asks for the header
            // to be left off, and a token sent to an address that arrived in a response body would
            // be a token one tampered response away from leaving the house.
            anonymous: true,
            headers: {
                "Content-Length": String(chunk.length),
                "Content-Range": `bytes ${offset}-${last}/${size}`,
            },
            body: chunk,
            signal,
        });

        offset = last + 1;

        // A 202 names the ranges Microsoft still wants. If that disagrees with our own position we
        // stop instead of guessing: the next chunk would land at the wrong offset, and the file
        // would come out the right length with shifted content — which the size check at the end
        // cannot see.
        const expected = response?.body?.nextExpectedRanges?.[0];
        if (typeof expected === "string") {
            const start = Number.parseInt(expected.split("-")[0], 10);
            if (Number.isInteger(start) && start !== offset) {
                throw new GraphError(`OneDrive expected the next chunk at ${start}, not at ${offset}`);
            }
        }
    };

    try {
        // `for await` and an awaited PUT inside the loop are the whole backpressure design: while a
        // chunk is in flight — including any throttling backoff inside graph.request — this
        // iterator is suspended and nothing is pulled from the source. Reading ahead here would
        // fill FileTransfer's 8 MiB buffer within seconds of a 90 second Retry-After, and the
        // transfer would die with "Destination too slow" while the backoff was working perfectly.
        for await (const piece of source) {
            queue.push(piece);
            queued += piece.length;

            while (queued >= CHUNK_SIZE) await putChunk(takeChunk(CHUNK_SIZE));
        }

        if (queued > 0) await putChunk(takeChunk(queued));

        if (offset !== size) {
            throw new GraphError(`OneDrive received ${offset} bytes but expected ${size}`);
        }
    } catch (error) {
        await discardSession(graph, connectionId, uploadUrl);
        throw error;
    }
};

module.exports = { CHUNK_SIZE, SIMPLE_UPLOAD_LIMIT, uploadLarge };

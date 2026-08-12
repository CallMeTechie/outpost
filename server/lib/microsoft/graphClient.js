const { getAccessToken, forget } = require("./tokenStore");
const {
    GraphError, describeGraphFailure, isPermanentFailure, readGraphCode, readRetryAfter,
} = require("./graphErrors");

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0/me/drive`;

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;

// The ceiling on a single wait. FileTransfer's own stall watchdog gives a full pipeline 600 s, so
// staying well under that is what keeps a legitimate backoff from being read as a wedged
// destination.
const MAX_WAIT_MS = 120_000;

// The ceiling on all waits of one request added together — a different question from how long any
// one of them may be, and it must not collapse into it: four Retry-Afters of 110 s are each legal
// and their sum is still inside what the 600 s watchdog tolerates. readFile passes a far smaller
// budget of its own, because an empty pipeline gets only 60 s.
const MAX_TOTAL_WAIT_MS = 480_000;

const readBody = async (response) => {
    try {
        return await response.json();
    } catch {
        return null;
    }
};

const backoffDelay = (attempt, random) => {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_WAIT_MS);
    const spread = base * 0.2 * (random() * 2 - 1);
    return Math.min(MAX_WAIT_MS, Math.max(0, Math.round(base + spread)));
};

const cancelled = () => new GraphError("The OneDrive request was cancelled", { code: "cancelled" });

// An unparsable URL counts as foreign: this is the check that decides where a bearer token may go,
// so anything it cannot read has to fail closed.
const originOf = (url) => {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
};

const createGraphClient = ({ getAccessToken: loadToken, forgetToken, fetchImpl, sleep, random = Math.random }) => {
    const request = async (connectionId, {
        url, method = "GET", headers = {}, body = undefined, signal = undefined, parse = "json",
        anonymous = false, maxWaitMs = MAX_WAIT_MS, maxTotalWaitMs = MAX_TOTAL_WAIT_MS,
    }) => {
        const target = url.startsWith("https://") ? url : `${GRAPH_BASE}${url}`;

        // The invariant below, enforced instead of merely written down. Every absolute URL this
        // client is handed came out of a response body — an upload session URL, an @odata.nextLink
        // — and listDir follows the latter straight back in here. `anonymous` is the flag that says
        // "this address is pre-authenticated, send no token"; without it the token would go
        // wherever the body said, which is the whole exfiltration channel the invariant exists to
        // close. A relative URL is built on GRAPH_BASE and needs no check.
        if (!anonymous && url.startsWith("https://") && originOf(url) !== GRAPH_ORIGIN) {
            throw new GraphError(`OneDrive will not send its access token to ${originOf(url) ?? "an unreadable address"}`,
                { code: "foreignHost" });
        }

        let droppedToken = false;
        let totalWaited = 0;

        // Two budgets, because one number cannot express both: `maxWaitMs` is how long a single
        // wait may be, `maxTotalWaitMs` how much they may add up to over all attempts. Callers whose
        // caller is watching a clock pass a tighter pair — see readFile in oneDriveAdapter.js, which
        // sits under FileTransfer's 60 s read-stall window. Returns false rather than throwing, so
        // each call site can fail with the error that belongs to its own situation.
        const affordWait = (ms) => {
            if (ms > maxWaitMs || totalWaited + ms > maxTotalWaitMs) return false;
            totalWaited += ms;
            return true;
        };

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            if (signal?.aborted) throw cancelled();

            // An upload session URL is pre-authenticated. Microsoft states the chunk PUTs must not
            // carry an Authorization header, and sending the bearer token to a URL that arrived
            // inside a response body would turn that body into an exfiltration channel the moment
            // it could be tampered with. So the token goes to graph.microsoft.com and nowhere else.
            let auth = {};
            if (!anonymous) {
                // Per attempt, never hoisted out of the loop: a large upload outlives an access
                // token, and the store renews it inside the five minute buffer unnoticed.
                auth = { Authorization: `Bearer ${await loadToken(connectionId)}` };
            }

            let response;
            try {
                response = await fetchImpl(target, {
                    method,
                    headers: { ...headers, ...auth },
                    body,
                    signal,
                });
            } catch (error) {
                if (signal?.aborted || error?.name === "AbortError") throw cancelled();
                if (attempt === MAX_ATTEMPTS) throw new GraphError("OneDrive is unreachable", { code: "network" });

                const wait = backoffDelay(attempt, random);
                if (!affordWait(wait)) throw new GraphError("OneDrive is unreachable", { code: "network" });

                await sleep(wait);
                continue;
            }

            if (response.ok) {
                if (parse === "raw") return response;
                return { status: response.status, headers: response.headers, body: await readBody(response) };
            }

            // Once, and only once, and never on the last attempt. The store hands out a cached
            // token, so a token that expired mid-transfer is worth one repeat; a second refusal
            // means the grant itself is gone and repeating would only hammer Microsoft. The attempt
            // guard is what keeps a 401 from falling out of the loop and being reported as
            // "OneDrive is temporarily unavailable" with no status and no code — an auth failure
            // described as an outage, and no way for a caller to tell.
            if (response.status === 401 && !anonymous && !droppedToken && attempt < MAX_ATTEMPTS) {
                droppedToken = true;
                forgetToken(connectionId);
                continue;
            }

            const payload = await readBody(response);
            const retryAfter = readRetryAfter(response.headers);
            const fail = () => new GraphError(describeGraphFailure(response.status, payload), {
                status: response.status, code: readGraphCode(payload), retryAfter,
            });

            // A permanent failure is excluded even when its status looks retryable: no amount of
            // waiting frees up quota. The rule lives in graphErrors so that this decision and the
            // sentence the user reads can never drift apart — a 500 carrying quotaLimitReached used
            // to be retried five times and then reported as a full drive.
            const worthRepeating = (response.status === 429 || response.status >= 500)
                && !isPermanentFailure(response.status, payload);
            if (!worthRepeating || attempt === MAX_ATTEMPTS) throw fail();

            // A wait longer than the budget is not a wait, it is a refusal with extra steps — and
            // that holds for the sum just as much as for the single wait: four legal-looking
            // Retry-Afters add up to the same wedged transfer as one illegal one.
            const wait = retryAfter !== null ? retryAfter * 1000 : backoffDelay(attempt, random);
            if (!affordWait(wait)) throw fail();

            await sleep(wait);
        }

        // Not reachable today: every path out of the loop either returns or throws its own
        // translated failure. It stays as the backstop for a future `continue` that forgets to, and
        // it must never again be the way an ordinary status leaves this function — a caller that
        // gets this error has no status and no code to branch on.
        throw new GraphError("OneDrive is temporarily unavailable");
    };

    return { request };
};

const graph = createGraphClient({
    getAccessToken,
    forgetToken: forget,
    fetchImpl: (url, options) => fetch(url, options),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

module.exports = {
    GRAPH_BASE, GRAPH_ORIGIN, MAX_ATTEMPTS, MAX_WAIT_MS, MAX_TOTAL_WAIT_MS,
    backoffDelay, createGraphClient, graph,
};

const { VaultError, VaultErrorCode, VaultErrorMessage } = require("../errors");
const { itemRef } = require("../visibility");
const { createRateLimit, callerKey } = require("../broker");
const { MIN_LENGTH, secretVariants, redactSecretText, truncateAndRedact } = require("../redact");

const NAME = "vault_http";
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const READS = new Set(["GET", "HEAD"]);
const FORBIDDEN_HEADERS = new Set([
    "authorization", "cookie", "host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "expect", "te", "trailer",
    "range", "if-range", "x-http-method-override", "x-method-override", "x-http-method",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_INVALID = /[^\t\x20-\x7e\x80-\xff]/;
const URL_LIMIT = 8 * 1024;
const HEADERS_LIMIT = 8 * 1024;
const MAX_HEADERS = 30;
const BODY_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 256 * 1024;
const TIMEOUT_MS = 30 * 1000;
const MAX_REDIRECTS = 5;
const MAX_RUNNING = 4;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set(["content-type", "content-encoding", "content-language", "content-location"]);
const SHOWN_HEADERS = new Set(["content-type", "content-length", "location", "link", "etag", "last-modified", "retry-after", "x-github-request-id"]);
const TEXT_TYPE = /^text\/|json|xml|javascript|x-www-form-urlencoded/i;
// fetch decodes exactly these; any other encoding would reach the redaction still compressed.
const DECODED_ENCODINGS = new Set(["", "identity", "gzip", "x-gzip", "deflate", "br"]);

const def = {
    name: NAME,
    description: "Call an HTTP API with a vault API key. Outpost sends the request itself and sets the entry's header; you never see the token, and it is replaced by •••• wherever the response repeats it. Only the entry's hosts, https unless the entry allows http, GET/HEAD only for read-only entries. Writes (POST, PUT, PATCH, DELETE) need their own approval. Prefer this over curl or gh with a token.",
    inputSchema: {
        type: "object",
        properties: {
            item: { type: "string", description: "Entry id as vault_list shows it, e.g. github-api or org:3/shop-api" },
            method: { type: "string", enum: [...METHODS] },
            url: { type: "string", description: "Absolute https URL (http only if the entry allows it) on one of the entry's hosts" },
            headers: { type: "object", additionalProperties: { type: "string" }, description: "Additional request headers; Outpost sets authentication, Host, Cookie, Content-Length and hop-by-hop headers itself" },
            body: { type: "string", description: "Request body, at most 1 MB; not allowed with GET or HEAD" },
        },
        required: ["item", "method", "url"],
    },
};

const textResult = (text) => ({ content: [{ type: "text", text }] });

const createHttpLimits = () => {
    const running = new Map();
    return {
        rate: createRateLimit({ windowMs: 60 * 1000, limit: 60 }),
        enter: (ctx) => {
            const key = callerKey(ctx);
            const count = running.get(key) ?? 0;
            if (count >= MAX_RUNNING) throw new VaultError(VaultErrorCode.BUSY);
            running.set(key, count + 1);
            return key;
        },
        leave: (key) => {
            const count = (running.get(key) ?? 1) - 1;
            if (count > 0) running.set(key, count);
            else running.delete(key);
        },
    };
};

const parseUrl = (value) => {
    if (typeof value !== "string" || Buffer.byteLength(value) > URL_LIMIT) return null;
    try {
        const url = new URL(value);
        return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url : null;
    } catch {
        return null;
    }
};

const headerProblem = (headers, entryHeader) => {
    if (headers == null) return null;
    if (typeof headers !== "object" || Array.isArray(headers)) return "shape";
    const entries = Object.entries(headers);
    if (entries.length > MAX_HEADERS) return "shape";
    let size = 0;
    for (const [name, value] of entries) {
        if (!HEADER_NAME.test(name) || typeof value !== "string" || HEADER_VALUE_INVALID.test(value)) return "shape";
        size += Buffer.byteLength(name) + Buffer.byteLength(value);
        const lower = name.toLowerCase();
        if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-") || lower === entryHeader.toLowerCase()) return "forbidden";
    }
    return size > HEADERS_LIMIT ? "shape" : null;
};

const assertRequest = (item, { url, method, headers, body }) => {
    const fields = item.fields ?? {};
    if (item.type !== "api_key")
        throw new VaultError(VaultErrorCode.WRONG_TYPE, `${itemRef(item)} is a ${item.type} entry; vault_http uses API key entries only.`);
    if (!url) throw new VaultError(VaultErrorCode.BAD_URL);
    if (url.protocol === "http:" && fields.allowHttp !== true) throw new VaultError(VaultErrorCode.HTTP_NOT_ALLOWED);
    if (!(fields.hosts ?? []).some((host) => String(host).toLowerCase() === url.host)) throw new VaultError(VaultErrorCode.HOST_NOT_ALLOWED);
    if (!METHODS.has(method)) throw new VaultError(VaultErrorCode.BAD_METHOD);
    if (fields.readOnly === true && !READS.has(method)) throw new VaultError(VaultErrorCode.READ_ONLY);
    const problem = headerProblem(headers, fields.headerName ?? "Authorization");
    if (problem === "shape")
        throw new VaultError(VaultErrorCode.HEADER_NOT_ALLOWED,
            `headers must be an object of at most ${MAX_HEADERS} headers with token names and single-line string values, at most ${HEADERS_LIMIT / 1024} KB together.`);
    if (problem) throw new VaultError(VaultErrorCode.HEADER_NOT_ALLOWED);
    if (body != null && (typeof body !== "string" || READS.has(method) || Buffer.byteLength(body) > BODY_LIMIT))
        throw new VaultError(VaultErrorCode.BAD_BODY);
};

const sameOrigin = (location, base) => {
    if (!location) return null;
    try {
        const next = new URL(location, base);
        return next.origin === base.origin ? next : null;
    } catch {
        return null;
    }
};

// Only redirects on the same origin are followed: the token must never reach another host.
const send = async ({ url, method, headers, body, signal }) => {
    let current = url;
    let currentMethod = method;
    let currentBody = body;
    let currentHeaders = headers;
    const request = () => fetch(current, { method: currentMethod, headers: currentHeaders, body: currentBody, redirect: "manual", signal });
    let response = await request();
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
        const next = REDIRECTS.has(response.status) ? sameOrigin(response.headers.get("location"), current) : null;
        if (!next) break;
        await response.body?.cancel();
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
            currentMethod = currentMethod === "HEAD" ? "HEAD" : "GET";
            currentBody = undefined;
            currentHeaders = Object.fromEntries(Object.entries(currentHeaders).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())));
        }
        current = next;
        response = await request();
    }
    return response;
};

const readCapped = async (response, limit) => {
    const chunks = [];
    let size = 0;
    if (response.body) {
        for await (const chunk of response.body) {
            chunks.push(chunk);
            size += chunk.length;
            if (size >= limit) break;
        }
    }
    return Buffer.concat(chunks).subarray(0, limit);
};

const isText = (headers) => {
    const type = headers.get("content-type") ?? "";
    const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1]?.toLowerCase() ?? "utf-8";
    const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase();
    return TEXT_TYPE.test(type) && (charset === "utf-8" || charset === "utf8") && DECODED_ENCODINGS.has(encoding);
};

const bodyText = (headers, raw, size, variants) => {
    if (raw.length === 0) return "";
    if (!isText(headers)) return `[binary body, ${redactSecretText(headers.get("content-type") ?? "", variants) || "no content type"}, ${size}]`;
    return truncateAndRedact(raw.toString("utf8"), RESPONSE_LIMIT, variants).text;
};

const formatResponse = (response, raw, size, variants) => {
    const lines = [`HTTP ${response.status}`];
    for (const [name, value] of response.headers)
        if (SHOWN_HEADERS.has(name) || name.startsWith("x-ratelimit-")) lines.push(`${name}: ${redactSecretText(value, variants)}`);
    return `${lines.join("\n")}\n\n${bodyText(response.headers, raw, size, variants)}`;
};

const failure = (err, ctx) => {
    if (ctx.signal?.aborted) return new VaultError(VaultErrorCode.CLIENT_GONE);
    const code = String(err?.cause?.code ?? err?.code ?? "");
    const kind = err?.name === "TimeoutError" ? "timeout" : /CERT|TLS|SSL|UNABLE_TO_VERIFY/.test(code) ? "TLS" : "connection";
    return new VaultError(VaultErrorCode.HTTP_FAILED, VaultErrorMessage[VaultErrorCode.HTTP_FAILED].replace("<kind>", kind));
};

const handler = async (args, ctx, { broker, httpLimits }) => {
    const method = typeof args.method === "string" ? args.method.toUpperCase() : "";
    const url = parseUrl(args.url);
    const details = { method: method.slice(0, 10) || null, host: url?.host ?? null, path: url ? url.pathname.slice(0, 200) : null };
    let entered = null;
    try {
        const { result } = await broker.use({
            ctx, itemRef: args.item, tool: NAME, access: READS.has(method) ? "read" : "write", field: "token", auditExtra: details,
            target: url ? `${method} ${url.host}${url.pathname}`.slice(0, 200) : null,
            precheck: () => httpLimits.rate(ctx),
            check: (item) => assertRequest(item, { url, method, headers: args.headers, body: args.body }),
            act: async (token, item) => {
                // Taken only now: a call waiting for the user's approval does not hold one of the 4 slots.
                entered = httpLimits.enter(ctx);
                if (token.length < MIN_LENGTH) throw new VaultError(VaultErrorCode.SECRET_TOO_SHORT);
                const fields = item.fields ?? {};
                const headerValue = (fields.headerTemplate ?? "Bearer {{secret}}").split("{{secret}}").join(token);
                const variants = secretVariants({ token, headerValue });
                // The 30 s start after the approval: the wait for the user is not part of the call.
                const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])]);
                try {
                    details.sent = true;
                    const response = await send({
                        url, method, body: args.body ?? undefined, signal,
                        headers: { ...(args.headers ?? {}), [fields.headerName ?? "Authorization"]: headerValue },
                    });
                    const raw = await readCapped(response, RESPONSE_LIMIT + 1);
                    // Content-Length counts the encoded bytes, but fetch hands over the decoded body.
                    const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
                    const declared = encoding === "" || encoding === "identity" ? Number.parseInt(response.headers.get("content-length") ?? "", 10) : NaN;
                    const bytes = Number.isSafeInteger(declared) && declared >= 0 ? declared : raw.length > RESPONSE_LIMIT ? null : raw.length;
                    Object.assign(details, { status: response.status, bytes });
                    return textResult(formatResponse(response, raw, bytes === null ? `more than ${RESPONSE_LIMIT} bytes` : `${bytes} bytes`, variants));
                } catch (err) {
                    if (err instanceof VaultError) throw err;
                    throw failure(err, ctx);
                }
            },
        });
        return result;
    } finally {
        if (entered) httpLimits.leave(entered);
    }
};

module.exports = { def, handler, needsBrowser: false, createHttpLimits };

const https = require("node:https");
const { VaultError, VaultErrorCode, VaultErrorMessage } = require("./errors");
const { visibleItems, itemRef } = require("./visibility");
const broker = require("./broker");
const approvals = require("./approvals");
const { secretVariants, redactSecretText } = require("./redact");
const { coversGit } = require("./gitHosts");
const { createAuditLog } = require("../../controllers/audit");
const logger = require("../../utils/logger");

const OPERATION_WINDOW_MS = 60 * 1000;
const IDLE_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 30;
const MAX_FORWARDS = 4;
const DEFAULT_GIT_USERNAME = "x-access-token";
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._~-]{1,100}$/;
const SERVICES = {
    "git-upload-pack": { service: "fetch", access: "read" },
    "git-receive-pack": { service: "push", access: "write" },
};
const REQUEST_HEADERS = ["content-type", "content-length", "accept", "content-encoding", "git-protocol", "user-agent"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "expires", "pragma"];
const FLUSH = Buffer.from("0000");
const C = VaultErrorCode;

const refusal = (code, values = {}) =>
    new VaultError(code, Object.entries(values).reduce((text, [name, value]) => text.replace(`<${name}>`, () => value),VaultErrorMessage[code]));

const parseHost = (value) => {
    const match = /^([^:]+)(?::([1-9][0-9]{0,4}))?$/.exec(value.toLowerCase());
    if (!match || match[1].length > 253 || !match[1].split(".").every((label) => LABEL.test(label))) return null;
    if (match[2] && (Number(match[2]) > 65535 || match[2] === "80" || match[2] === "443")) return null;
    return { host: match[0], hostname: match[1], port: match[2] ? Number(match[2]) : 443 };
};

const parseGitRequest = (method, path, query) => {
    const parts = path.split("/").slice(1);
    const target = parseHost(parts.shift() ?? "");
    let name = null;
    if (parts.at(-2) === "info" && parts.at(-1) === "refs") {
        if (method === "GET" && typeof query.service === "string" && Object.hasOwn(SERVICES, query.service)) name = query.service;
        parts.splice(-2);
    } else if (method === "POST" && Object.hasOwn(SERVICES, parts.at(-1) ?? "")) {
        name = parts.pop();
    }
    if (!target || !name || parts.length < 1 || parts.length > 8) return null;
    if (!parts.every((segment) => SEGMENT.test(segment) && segment !== "." && !segment.includes(".."))) return null;
    const repo = parts.join("/");
    const advertise = path.endsWith("/info/refs");
    return {
        ...target, name, advertise, repo, repoName: repo.replace(/\.git$/, ""), ...SERVICES[name],
        upstreamPath: advertise ? `/${repo}/info/refs?service=${name}` : `/${repo}/${name}`,
    };
};

const failureKind = (err) => {
    if (err?.message === "idle" || err?.code === "ETIMEDOUT") return "timeout";
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO/.test(String(err?.code ?? ""))) return "TLS";
    return "connection";
};

const pktLine = (text) => {
    const payload = Buffer.from(`${text}\n`);
    return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, "0")), payload]);
};

// Rejected requests close the connection: a body Outpost never reads must not keep it open.
const refuse = (res, status, contentType, body) => {
    if (res.headersSent || res.destroyed) return res.destroy();
    // Node detaches the socket before "finish" listeners run, so it is captured here.
    const socket = res.socket;
    res.on("finish", () => socket?.destroy());
    res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-cache", Connection: "close" });
    res.end(body);
};

const createGitProxy = ({ windowMs = OPERATION_WINDOW_MS, idleMs = IDLE_MS, agent = undefined } = {}) => {
    const operations = new Map();
    const forwards = new Map();
    const refusalsAudited = new Map();
    const advertiseRate = broker.createRateLimit({ windowMs: RATE_WINDOW_MS, limit: RATE_LIMIT });

    // Refusals before the broker repeat as fast as a script retries; one audit entry per key, code and minute says enough.
    const firstRefusal = (keyId, code) => {
        const now = Date.now();
        for (const [name, at] of refusalsAudited) if (now - at >= RATE_WINDOW_MS) refusalsAudited.delete(name);
        const name = `${keyId}|${code}`;
        if (refusalsAudited.has(name)) return false;
        refusalsAudited.set(name, now);
        return true;
    };

    const record = (ctx, item, action, details) => createAuditLog({
        accountId: ctx.accountId, organizationId: item?.organizationId ?? null, action,
        resource: "vault", resourceId: item?.id ?? null,
        details: { item: item ? itemRef(item) : null, agentType: "git", keyId: ctx.keyId, entryId: ctx.agent.entryId, tool: "git", ...details },
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    }).catch((err) => logger.warn("Could not audit a git operation", { error: err?.name }));

    const end = (op) => {
        if (op.ended) return;
        op.ended = true;
        clearTimeout(op.timer);
        if (operations.get(op.key) === op) operations.delete(op.key);
        op.recordUse?.({ bytes: op.bytes });
    };

    const settle = (op) => {
        op.active -= 1;
        clearTimeout(op.timer);
        if (op.active > 0) return;
        if (op.finished) return end(op);
        op.timer = setTimeout(() => end(op), windowMs);
        op.timer.unref?.();
    };

    const findGitItem = async (ctx, host) => {
        const items = (await visibleItems({ accountId: ctx.accountId, agent: ctx.agent })).filter((item) => coversGit(item, host));
        if (items.length === 0) throw refusal(C.GIT_NOT_ENABLED, { host });
        if (items.length > 1) throw refusal(C.GIT_AMBIGUOUS, { host, entries: items.map(itemRef).join(", ") });
        return items[0];
    };

    const forward = ({ req, res, request, basic, onAccepted }) => new Promise((resolve, reject) => {
        let bytes = 0;
        let sent = 0;
        let head = Buffer.alloc(0);
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve({ bytes, onlyFlush: sent === FLUSH.length && head.equals(FLUSH) });
        };
        const headers = { authorization: `Basic ${basic}` };
        for (const name of REQUEST_HEADERS) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
        const upstream = https.request({ hostname: request.hostname, port: request.port, method: req.method, path: request.upstreamPath, headers, agent });
        upstream.setTimeout(idleMs, () => upstream.destroy(new Error("idle")));
        upstream.on("error", (err) => {
            if (res.headersSent) return res.destroy();
            if (settled) return;
            settled = true;
            reject(refusal(C.HTTP_FAILED, { kind: failureKind(err) }));
        });
        upstream.on("response", (answer) => {
            if (answer.statusCode === 401 || answer.statusCode === 403) {
                answer.resume();
                upstream.destroy();
                settled = true;
                return reject(refusal(C.UPSTREAM_REFUSED, { host: request.host }));
            }
            onAccepted(answer.statusCode);
            const out = {};
            for (const name of RESPONSE_HEADERS) if (answer.headers[name] !== undefined) out[name] = answer.headers[name];
            res.writeHead(answer.statusCode, out);
            answer.on("data", (chunk) => { bytes += chunk.length; });
            answer.on("error", () => res.destroy());
            answer.pipe(res);
        });
        res.on("finish", finish);
        res.on("close", () => {
            upstream.destroy();
            finish();
        });
        req.on("data", (chunk) => {
            bytes += chunk.length;
            sent += chunk.length;
            if (head.length < 8) head = Buffer.concat([head, chunk]).subarray(0, 8);
        });
        req.pipe(upstream);
    });

    const handle = async (req, res) => {
        const request = parseGitRequest(req.method, req.path, req.query ?? {});
        if (!request) return refuse(res, 404, "text/plain; charset=utf-8", "Not found\n");
        if (req.agent?.agentType !== "git")
            return refuse(res, 403, "text/plain; charset=utf-8", "Only git keys can use the vault git proxy.\n");

        const keyId = req.agent.keyId;
        const transportId = approvals.gitSessionId(keyId);
        approvals.touchSession(transportId);
        const controller = new AbortController();
        res.on("close", () => { if (!res.writableFinished) controller.abort(); });
        const ctx = {
            accountId: req.user.id, keyId, agent: req.agent, transportId, impersonatorId: null, signal: controller.signal,
            ipAddress: req.ip ?? null, userAgent: req.headers["user-agent"] ?? null,
        };
        const details = { host: request.host, repo: request.repoName, service: request.service };
        const key = `${keyId}|${request.name}|${request.host}/${request.repoName}`;
        let variants = [];
        let op = null;
        let item = null;
        let brokered = false;
        let pushing = false;
        try {
            if (request.advertise) {
                advertiseRate(ctx);
                item = await findGitItem(ctx, request.host);
            } else {
                const current = operations.get(key);
                if (!current || current.ended || current.finished || current.pushing) throw new VaultError(C.GIT_NO_OPERATION);
                op = current;
                op.active += 1;
                clearTimeout(op.timer);
                item = op.item;
                if (request.name === "git-receive-pack") pushing = op.pushing = true;
            }
            const check = (candidate) => {
                if (!coversGit(candidate, request.host)) throw refusal(C.GIT_NOT_ENABLED, { host: request.host });
                if (request.name === "git-receive-pack" && candidate.fields.readOnly === true) throw new VaultError(C.READ_ONLY);
            };
            const act = async (secret, current) => {
                if (secret.length < 4) throw new VaultError(C.SECRET_TOO_SHORT);
                if ((forwards.get(keyId) ?? 0) >= MAX_FORWARDS) throw new VaultError(C.BUSY);
                const username = current.fields.gitUsername || DEFAULT_GIT_USERNAME;
                variants = secretVariants({ token: secret, gitUsername: username });
                const basic = Buffer.from(`${username}:${secret}`).toString("base64");
                if (ctx.signal.aborted || req.destroyed || res.destroyed) throw new VaultError(C.CLIENT_GONE);
                forwards.set(keyId, (forwards.get(keyId) ?? 0) + 1);
                req.clearRequestDeadline();
                try {
                    const outcome = await forward({
                        req, res, request, basic,
                        // Registered before the advertisement reaches Git: Git sends its first POST as soon as it has read it.
                        onAccepted: (status) => {
                            if (!request.advertise || status !== 200) return;
                            const previous = operations.get(key);
                            op = {
                                key, item: current, stamp: approvals.grantStamp(current),
                                active: 1, bytes: 0, pushing: false, finished: false, ended: false, timer: null, recordUse: null,
                            };
                            operations.set(key, op);
                            if (previous && previous.active === 0) end(previous);
                        },
                    });
                    if (op) op.bytes += outcome.bytes;
                    if (op && request.name === "git-receive-pack" && !request.advertise && !outcome.onlyFlush) op.finished = true;
                    return outcome;
                } finally {
                    forwards.set(keyId, forwards.get(keyId) - 1);
                }
            };
            brokered = true;
            const { result, recordUse } = await broker.use({
                ctx, itemRef: itemRef(item), tool: "git", access: request.access, target: `Git · ${request.host}/${request.repoName}`,
                field: "token", check, act, approved: request.advertise ? null : { itemId: op.item.id, stamp: op.stamp },
                auditExtra: details, deferUse: true,
            });
            if (request.advertise && op) op.recordUse = recordUse;
            else if (request.advertise) await recordUse({ bytes: result.bytes });
        } catch (err) {
            if (!(err instanceof VaultError)) logger.warn("Git proxy request failed", { error: err?.name });
            if (!brokered && err instanceof VaultError && firstRefusal(keyId, err.code))
                record(ctx, item, "vault.use_denied", { access: request.access, ...details, code: err.code });
            const message = redactSecretText(err instanceof VaultError ? `${err.message} (${err.code})` : "The git request failed unexpectedly; nothing was sent.", variants);
            if (request.advertise) refuse(res, 200, `application/x-${request.name}-advertisement`, pktLine(`ERR vault: ${message}`));
            else refuse(res, 403, "text/plain; charset=utf-8", `vault: ${message}\n`);
        } finally {
            variants = [];
            if (pushing) op.pushing = false;
            if (op) settle(op);
        }
    };

    return { handle };
};

module.exports = { createGitProxy, parseGitRequest };

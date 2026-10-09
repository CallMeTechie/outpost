const { createHash } = require("node:crypto");
const { BrowserError, BrowserErrorCode } = require("./errors");

const EXPRESSION_LOG_LIMIT = 500;
const WAIT_POLL_MS = 250;
const WAIT_DEFAULT_MS = 10000;
const WAIT_MAX_MS = 60000;

const SESSION_ID = {
    sessionId: { type: "string", description: "Browser session id. Defaults to the session this connection opened last; may be left out while only one session is open." },
};

const tool = (name, description, properties = {}, required = [], { session = true } = {}) => ({
    name,
    description,
    inputSchema: { type: "object", properties: { ...properties, ...(session ? SESSION_ID : {}) }, ...(required.length > 0 && { required }) },
});

const TOOL_DEFS = [
    tool("browser_open", "Open a web page in a new Outpost browser tab that the user watches live and can take over. Returns the session id and an accessibility snapshot; its [ref=eN] markers are what browser_click and browser_type take.", {
        url: { type: "string", description: "http or https URL" },
        via: { type: "string", description: "Name or id of an SSH server entry. The URL's host and port are tunneled through it, for dev servers that listen on that machine's localhost. Cannot be combined with profile=persistent." },
        profile: { type: "string", enum: ["ephemeral", "persistent"], description: "persistent keeps cookies and logins of this Outpost account across sessions; default ephemeral" },
    }, ["url"], { session: false }),
    tool("browser_navigate", "Navigate the session to a URL and return the snapshot afterwards.", { url: { type: "string" } }, ["url"]),
    tool("browser_snapshot", "Return the accessibility snapshot of the page with refs."),
    tool("browser_click", "Click an element by ref with a real mouse event and return the snapshot afterwards.", {
        ref: { type: "string" },
        button: { type: "string", enum: ["left", "middle", "right"] },
        clickCount: { type: "integer", minimum: 1, maximum: 3 },
    }, ["ref"]),
    tool("browser_type", "Replace the content of an input by ref with text, using real input events. submit=true presses Enter afterwards. On a native select (combobox with options in the snapshot) it chooses the option with exactly this text.", {
        ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" },
    }, ["ref", "text"]),
    tool("browser_key", "Press a key or combination, e.g. Enter, Escape, Tab, Control+a.", { key: { type: "string" } }, ["key"]),
    tool("browser_scroll", "Scroll the page, or the element given by ref, by deltaY pixels.", { ref: { type: "string" }, deltaY: { type: "number" } }, ["deltaY"]),
    tool("browser_screenshot", "Capture a PNG screenshot of the page.", { fullPage: { type: "boolean" } }),
    tool("browser_wait", "Wait until the page has loaded (load), shows a text (text), a ref is visible (ref), or some milliseconds have passed (ms).", {
        condition: { type: "string", enum: ["load", "text", "ref", "ms"] },
        value: { type: ["string", "number"] },
        timeoutMs: { type: "integer", minimum: 1, maximum: WAIT_MAX_MS },
    }, ["condition"]),
    tool("browser_evaluate", "Evaluate a JavaScript expression in the page and return its JSON value. Every evaluation is written to the audit log.", { expression: { type: "string" } }, ["expression"]),
    tool("browser_close", "End the browser session; its tab closes for the user as well."),
    tool("browser_list", "List the open browser sessions of this account.", {}, [], { session: false }),
];

const textResult = (text) => ({ content: [{ type: "text", text }] });
// Credentials and fragments (OAuth implicit tokens) in a URL are as secret as typed text,
// which never reaches the audit log either.
const auditUrl = (raw) => {
    try {
        const url = new URL(String(raw));
        url.username = "";
        url.password = "";
        url.hash = "";
        return url.href;
    } catch {
        return String(raw);
    }
};
const formatSessions = (sessions) => sessions.map((s) => `- ${s.id}  ${s.title || "(untitled)"}  ${s.url}`).join("\n");
const errorResult = (err) => {
    const list = err.details?.sessions?.length ? `\nOpen sessions:\n${formatSessions(err.details.sessions)}` : "";
    return { isError: true, content: [{ type: "text", text: `${err.message}${list}` }] };
};
const pageResult = (session, snapshot, note = "") =>
    textResult(`Session: ${session.id}\nURL: ${session.state.url}\nTitle: ${session.state.title}${note}\n\n${snapshot}`);

const createBrowserTools = ({
    getPool,
    audit = (entry) => require("../../controllers/audit").createAuditLog(entry),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
    const defaults = new Map();

    const resolveSession = ({ accountId, transportId }, sessionId) => {
        const pool = getPool();
        if (sessionId) {
            const session = pool.getOwned(accountId, sessionId);
            if (!session)
                throw new BrowserError(BrowserErrorCode.UNKNOWN_SESSION, `No open browser session ${sessionId} for this account.`, { sessions: pool.listForAccount(accountId) });
            return session;
        }
        const remembered = defaults.get(transportId);
        if (remembered) {
            const session = pool.getOwned(accountId, remembered);
            if (session) return session;
            // Falling back to "the only open session" here would hand this connection another
            // process's session exactly when its own is gone.
            throw new BrowserError(BrowserErrorCode.SESSION_CLOSED,
                `Your browser session ${remembered} has ended. Open a new one with browser_open or pass a sessionId.`,
                { sessions: pool.listForAccount(accountId) });
        }
        // A session another connection opened stays its own: otherwise a connection whose own session
        // is gone (server restart, transport sweep) would act on someone else's (A11).
        const claimed = new Set(defaults.values());
        const all = pool.listForAccount(accountId);
        const open = all.filter((session) => !claimed.has(session.id));
        if (open.length === 1) return pool.getOwned(accountId, open[0].id);
        if (open.length === 0) {
            throw new BrowserError(BrowserErrorCode.NO_SESSION, all.length === 0
                ? "No browser session is open. Call browser_open first."
                : "No browser session of this connection is open; the open ones belong to other connections. Call browser_open, or pass sessionId.",
            { sessions: all });
        }
        throw new BrowserError(BrowserErrorCode.AMBIGUOUS_SESSION,
            "More than one browser session is open and this connection has none of its own. Pass sessionId.", { sessions: open });
    };

    const record = (ctx, session, action, details) => audit({
        accountId: ctx.accountId,
        organizationId: session.organizationId ?? null,
        action,
        resource: "browser",
        details: { url: auditUrl(session.state.url), sessionId: session.id, ...details },
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
    });

    const snapshotAfter = async (session, note) => {
        await session.settle();
        return pageResult(session, await session.snapshot(), note);
    };

    const act = (name, fn) => async (args, ctx) => {
        const session = resolveSession(ctx, args.sessionId);
        return session.runAgent(name, () => fn(session, args, ctx));
    };

    const waitFor = async (session, { condition, value, timeoutMs }) => {
        if (condition === "ms") {
            await sleep(Math.min(Math.max(Number(value) || 0, 0), WAIT_MAX_MS));
            return snapshotAfter(session);
        }
        const checks = {
            load: async () => !session.state.loading && (await session.evaluate("document.readyState")) === "complete",
            text: async () => (await session.evaluate(`(document.body?.innerText ?? '').includes(${JSON.stringify(String(value))})`)) === true,
            ref: () => session.refVisible(value).then(() => true, (err) => {
                if (err.code === BrowserErrorCode.STALE_REF || err.code === BrowserErrorCode.UNKNOWN_REF) throw err;
                return false;
            }),
        };
        const check = Object.hasOwn(checks, condition) ? checks[condition] : null;
        if (!check) throw new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, `Unknown condition "${condition}"; use load, text, ref or ms`);
        if (condition !== "load" && (value === undefined || value === null))
            throw new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, `Condition ${condition} needs a value: the ${condition} to wait for`);
        const limit = Math.min(Number(timeoutMs) || WAIT_DEFAULT_MS, WAIT_MAX_MS);
        for (let waited = 0; ; waited += WAIT_POLL_MS) {
            if (await check()) return snapshotAfter(session);
            if (waited >= limit)
                throw new BrowserError(BrowserErrorCode.TIMEOUT, `Condition ${condition}${value === undefined ? "" : ` "${value}"`} not met within ${limit} ms`);
            await sleep(WAIT_POLL_MS);
        }
    };

    const handlers = {
        browser_open: async (args, ctx) => {
            const { session, navigationError } = await getPool().open({
                accountId: ctx.accountId, url: args.url, via: args.via ?? null, profile: args.profile ?? "ephemeral", origin: "agent",
            });
            defaults.set(ctx.transportId, session.id);
            await record(ctx, session, "browser.open", { url: auditUrl(args.url), tool: "browser_open", via: session.via ?? null });
            try {
                return await session.runAgent("browser_open", () => snapshotAfter(session, navigationError ? `\nNavigation failed: ${navigationError}` : ""));
            } catch (err) {
                // The session exists even when its first snapshot fails (a dialog on load); say so, or the agent opens another.
                if (err instanceof BrowserError) err.message = `Session ${session.id} is open. ${err.message}`;
                throw err;
            }
        },
        browser_navigate: act("browser_navigate", async (session, { url }, ctx) => {
            await record(ctx, session, "browser.navigate", { tool: "browser_navigate", target: auditUrl(url) });
            await session.navigate(url);
            return snapshotAfter(session);
        }),
        browser_snapshot: act("browser_snapshot", (session) => snapshotAfter(session)),
        browser_click: act("browser_click", async (session, { ref, button, clickCount }, ctx) => {
            await record(ctx, session, "browser.click", { tool: "browser_click", target: session.labelOf(ref) });
            await session.click(ref, {
                button: ["left", "middle", "right"].includes(button) ? button : "left",
                clickCount: Math.min(Math.max(Math.trunc(Number(clickCount)) || 1, 1), 3),
            });
            return snapshotAfter(session);
        }),
        browser_type: act("browser_type", async (session, { ref, text, submit }, ctx) => {
            // The typed text is often a password; only the target goes into the audit log.
            await record(ctx, session, "browser.type", { tool: "browser_type", target: session.labelOf(ref) });
            await session.type(ref, text, { submit: !!submit });
            return snapshotAfter(session);
        }),
        browser_key: act("browser_key", async (session, { key }, ctx) => {
            await record(ctx, session, "browser.key", { tool: "browser_key", target: String(key) });
            await session.key(key);
            return snapshotAfter(session);
        }),
        browser_scroll: act("browser_scroll", async (session, { ref, deltaY }) => {
            await session.scroll({ ref: ref ?? null, deltaY: Number(deltaY) || 0 });
            return snapshotAfter(session);
        }),
        browser_screenshot: act("browser_screenshot", async (session, { fullPage }) => ({
            content: [{ type: "image", data: await session.screenshot(!!fullPage), mimeType: "image/png" }],
        })),
        browser_wait: act("browser_wait", (session, args) => waitFor(session, args)),
        browser_evaluate: act("browser_evaluate", async (session, { expression }, ctx) => {
            const full = String(expression);
            await record(ctx, session, "browser.evaluate", {
                tool: "browser_evaluate",
                expression: full.slice(0, EXPRESSION_LOG_LIMIT),
                // Padding can push the real code past the cut; length and hash keep the entry verifiable.
                expressionLength: full.length,
                expressionSha256: createHash("sha256").update(full).digest("hex"),
            });
            const value = await session.evaluate(expression);
            return textResult(value === undefined ? "undefined" : JSON.stringify(value, null, 2));
        }),
        browser_close: act("browser_close", async (session, args, ctx) => {
            await record(ctx, session, "browser.close", { tool: "browser_close" });
            if (defaults.get(ctx.transportId) === session.id) defaults.delete(ctx.transportId);
            await getPool().close(session.id, "closed by agent");
            return textResult(`Closed ${session.id}.`);
        }),
        browser_list: async (args, ctx) => {
            const open = getPool().listForAccount(ctx.accountId);
            return textResult(open.length > 0 ? formatSessions(open) : "No browser sessions are open.");
        },
    };

    return {
        list: () => TOOL_DEFS,
        has: (name) => Object.hasOwn(handlers, name),
        call: async (name, args, ctx) => {
            try {
                return await handlers[name](args ?? {}, ctx);
            } catch (err) {
                return errorResult(err instanceof BrowserError ? err : new BrowserError(BrowserErrorCode.INTERNAL, err.message));
            }
        },
        forgetTransport: (transportId) => defaults.delete(transportId),
    };
};

module.exports = { createBrowserTools };

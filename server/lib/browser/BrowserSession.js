const { EventEmitter } = require("node:events");
const { AsyncLocalStorage } = require("node:async_hooks");
const { encodeFrame, nextSeq } = require("./frameProtocol");
const { toCdpCalls, viewportCalls, clampViewport, assertNavigableUrl, SCREENCAST } = require("./input");
const { RefTable, buildSnapshot } = require("./snapshot");
const actions = require("./actions");
const { BrowserError, BrowserErrorCode } = require("./errors");
const logger = require("../../utils/logger");

const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const VIEWER_BUFFER_LIMIT = 2 * 1024 * 1024;
const AGENT_CALL_TIMEOUT_MS = 90000;
const STALL_MS = 1000;
const ACK_POLL_MS = 16;
const SETTLE_QUIET_MS = 150;
const SETTLE_POLL_MS = 50;
const SETTLE_MAX_MS = 10000;
const SCREENSHOT_MAX_HEIGHT = 16384;
// One oversized CDP message closes the connection every session of the instance shares.
const SCREENSHOT_MAX_PIXELS = 8e6;

// Bound to the work of one runAgent across its awaits: that work outlives an interrupted runAgent
// and has to see its own abort, not whatever call runs on the session by then.
const agentCall = new AsyncLocalStorage();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const originOf = (url) => {
    try {
        const { origin } = new URL(url);
        return origin === "null" ? "" : origin;
    } catch {
        return "";
    }
};

class BrowserSession extends EventEmitter {
    constructor({ id, accountId, profile, via = null, origin, organizationId = null, cdp, targetId, cdpSessionId,
                  bufferLimit = VIEWER_BUFFER_LIMIT, stallMs = STALL_MS }) {
        super();
        Object.assign(this, { id, accountId, profile, via, origin, organizationId, cdp, targetId, cdpSessionId, bufferLimit, stallMs });
        this.viewers = [];
        this.viewport = { ...DEFAULT_VIEWPORT };
        this.refs = new RefTable();
        this.state = { url: "about:blank", title: "", loading: false, canGoBack: false, canGoForward: false };
        this.agentPaused = false;
        this.agentTool = null;
        this.pendingDialog = null;
        this.dialogSeq = 0;
        this.screencasting = false;
        this.refreshing = 0;
        this.seq = 0;
        this.closed = false;
        this.closeReason = null;
        this.lastActivity = Date.now();
        this.send = (method, params = {}) => cdp.send(method, params, cdpSessionId);
        this.agentSend = (method, params = {}) => {
            agentCall.getStore()?.throwIfAborted();
            return this.send(method, params);
        };
        this.onCdpEvent = (event) => {
            if (event.sessionId !== cdpSessionId) return;
            this.#handleEvent(event).catch((err) => logger.warn("Browser session event failed", { session: id, method: event.method, error: err.message }));
        };
        cdp.on("event", this.onCdpEvent);
    }

    async start() {
        await this.send("Page.enable");
        await this.send("DOM.enable");
        await this.send("Page.setInterceptFileChooserDialog", { enabled: true });
        await this.#applyViewport(this.viewport);
        await this.#refreshState();
    }

    summary() {
        return {
            id: this.id, url: this.state.url, title: this.state.title, profile: this.profile, via: this.via,
            origin: this.origin, agentPaused: this.agentPaused, agentActive: this.agentTool !== null,
        };
    }

    addViewer(ws) {
        this.viewers.push({ ws, size: null, stalled: false });
        this.lastActivity = Date.now();
        this.#sendTo(ws, { type: "ready", sessionId: this.id, url: this.state.url, title: this.state.title, viewport: { ...this.viewport } });
        this.#sendTo(ws, { type: "state", ...this.state });
        this.#sendTo(ws, this.#agentMessage());
        if (this.pendingDialog) this.#sendTo(ws, { type: "dialog", ...this.pendingDialog });
        if (!this.screencasting) this.#startScreencast();
    }

    removeViewer(ws) {
        const index = this.viewers.findIndex((viewer) => viewer.ws === ws);
        if (index === -1) return;
        this.viewers.splice(index, 1);
        this.lastActivity = Date.now();
        if (this.viewers.length === 0) {
            this.screencasting = false;
            this.send("Page.stopScreencast").catch(() => {});
            return;
        }
        // The next-oldest viewer inherits authority without being told: a "you are authoritative"
        // message would be a second copy of this state that can drift (spec, "Das Bild").
        if (index === 0 && this.viewers[0].size) this.#applyViewport(this.viewers[0].size).catch(() => {});
    }

    async handleViewerMessage(ws, message) {
        switch (message?.type) {
            case "resize":
                return this.#viewerResize(ws, message);
            case "navigate":
                return this.navigate(message.url).catch((err) => {
                    if (err.code !== BrowserErrorCode.NAVIGATION_FAILED) this.#sendTo(ws, { type: "error", code: err.code, message: err.message });
                });
            case "nav":
                return this.history(message.action);
            case "pause":
                return this.setPaused(!!message.paused);
            case "close":
                return this.close("closed by user");
            case "dialogReply":
                // A reply meant for an earlier dialog must not answer the one showing now.
                if (!this.pendingDialog || message.id !== this.pendingDialog.id) return;
                this.pendingDialog = null;
                break;
        }
        for (const { method, params } of toCdpCalls(message)) await this.send(method, params);
    }

    async navigate(rawUrl) {
        const url = assertNavigableUrl(rawUrl);
        const { errorText } = await this.agentSend("Page.navigate", { url });
        if (errorText) {
            this.#broadcast({ type: "error", code: BrowserErrorCode.NAVIGATION_FAILED, message: `${url}: ${errorText}` });
            throw new BrowserError(BrowserErrorCode.NAVIGATION_FAILED, `Navigation to ${url} failed: ${errorText}`);
        }
    }

    async history(action) {
        if (action === "reload") {
            await this.send("Page.reload");
            return;
        }
        const step = action === "back" ? -1 : action === "forward" ? 1 : 0;
        if (step === 0) return;
        const { currentIndex, entries } = await this.send("Page.getNavigationHistory");
        const target = entries?.[currentIndex + step];
        if (target) await this.send("Page.navigateToHistoryEntry", { entryId: target.id });
    }

    setPaused(paused) {
        this.agentPaused = paused;
        this.#broadcast(this.#agentMessage());
        this.emit("change");
    }

    async runAgent(tool, fn) {
        if (this.closed) throw this.#closedError();
        if (this.agentPaused) throw new BrowserError(BrowserErrorCode.PAUSED, "The session is paused by the user. Wait and try again later.");
        if (this.pendingDialog) throw this.#dialogError();
        if (this.agentTool !== null) throw new BrowserError(BrowserErrorCode.BUSY, "Another agent action is still running on this session");
        this.lastActivity = Date.now();
        this.agentTool = tool;
        this.#broadcast(this.#agentMessage());
        this.emit("change");
        let onDialog;
        let timer;
        const controller = new AbortController();
        // A click or navigation that opens a page dialog does not return until someone answers it;
        // the agent gets the named refusal instead (spec, "Was schiefgehen kann").
        const interrupted = new Promise((_, reject) => {
            const stop = (err) => {
                controller.abort(err);
                reject(err);
            };
            onDialog = () => stop(this.#dialogError());
            this.once("dialog", onDialog);
            timer = setTimeout(() => stop(new BrowserError(BrowserErrorCode.TIMEOUT,
                `${tool} did not finish within ${AGENT_CALL_TIMEOUT_MS / 1000} s`)), AGENT_CALL_TIMEOUT_MS);
        });
        const work = agentCall.run(controller.signal, () => Promise.resolve().then(() => fn(this)));
        work.catch(() => {});
        try {
            return await Promise.race([work, interrupted]);
        } catch (err) {
            if (this.closed && !(err instanceof BrowserError)) throw this.#closedError();
            throw err;
        } finally {
            this.off("dialog", onDialog);
            clearTimeout(timer);
            this.agentTool = null;
            this.lastActivity = Date.now();
            if (!this.closed) {
                this.#broadcast(this.#agentMessage());
                this.emit("change");
            }
        }
    }

    async snapshot() {
        const { nodes } = await this.agentSend("Accessibility.getFullAXTree");
        return buildSnapshot(nodes ?? [], this.refs);
    }

    labelOf(ref) {
        return this.refs.resolve(ref).label;
    }

    async click(ref, options = {}) {
        const { backendNodeId, label } = this.refs.resolve(ref);
        await actions.click(this.agentSend, backendNodeId, options);
        return label;
    }

    async type(ref, text, options = {}) {
        const { backendNodeId, label, options: choices } = this.refs.resolve(ref);
        if (choices) await actions.selectOption(this.agentSend, backendNodeId, choices, text);
        else await actions.typeText(this.agentSend, backendNodeId, text, options);
        return label;
    }

    async key(combo) {
        await actions.pressKey(this.agentSend, combo);
    }

    async scroll({ ref = null, deltaY }) {
        const backendNodeId = ref ? this.refs.resolve(ref).backendNodeId : null;
        await actions.scroll(this.agentSend, { backendNodeId, deltaY, viewport: this.viewport });
    }

    async refVisible(ref) {
        await actions.clickablePoint(this.agentSend, this.refs.resolve(ref).backendNodeId);
    }

    async screenshot(fullPage = false) {
        const params = { format: "png" };
        if (fullPage) {
            const { cssContentSize } = await this.agentSend("Page.getLayoutMetrics");
            const width = Math.min(cssContentSize.width, SCREENSHOT_MAX_HEIGHT);
            const height = Math.min(cssContentSize.height, SCREENSHOT_MAX_HEIGHT);
            const scale = Math.min(1, Math.sqrt(SCREENSHOT_MAX_PIXELS / (width * height)));
            Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale } });
        }
        return (await this.agentSend("Page.captureScreenshot", params)).data;
    }

    async evaluate(expression) {
        const { result, exceptionDetails } = await this.agentSend("Runtime.evaluate", { expression: String(expression), returnByValue: true, awaitPromise: true });
        if (exceptionDetails)
            throw new BrowserError(BrowserErrorCode.EVALUATION_FAILED, exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result?.value;
    }

    async settle() {
        await sleep(SETTLE_QUIET_MS);
        const deadline = Date.now() + SETTLE_MAX_MS;
        while ((this.state.loading || this.refreshing > 0) && !this.closed && Date.now() < deadline) {
            agentCall.getStore()?.throwIfAborted();
            await sleep(SETTLE_POLL_MS);
        }
    }

    notifyDownload({ filename, state }) {
        this.#broadcast({ type: "download", filename, state });
    }

    notifyError(code, message) {
        this.#broadcast({ type: "error", code, message });
    }

    applyTargetInfo({ title }) {
        if (this.closed || typeof title !== "string" || title === this.state.title) return;
        this.state = { ...this.state, title };
        this.#broadcast({ type: "state", ...this.state });
        this.emit("change");
    }

    close(reason) {
        if (this.closed) return;
        this.closed = true;
        this.closeReason = reason;
        this.cdp.off("event", this.onCdpEvent);
        for (const { ws } of this.viewers) {
            this.#sendTo(ws, { type: "closed", reason });
            try {
                ws.close(1000, "Browser session closed");
            } catch {}
        }
        this.viewers = [];
        this.emit("closed", reason);
    }

    async #handleEvent({ method, params }) {
        switch (method) {
            case "Page.screencastFrame":
                return this.#onFrame(params);
            case "Page.frameStartedLoading":
                if (params.frameId !== this.targetId) return;
                this.state.loading = true;
                return this.#broadcast({ type: "state", ...this.state });
            case "Page.frameNavigated":
                if (params.frame?.parentId) return;
                this.refs.reset();
                await this.#resumeScreencast();
                return this.#refreshState();
            case "Page.navigatedWithinDocument":
                return this.#refreshState();
            case "Page.loadEventFired":
                this.state.loading = false;
                await this.#resumeScreencast();
                return this.#refreshState();
            case "Page.frameStoppedLoading":
                // Downloads and 204 answers end loading without a load event.
                if (params.frameId !== this.targetId || !this.state.loading) return;
                this.state.loading = false;
                return this.#broadcast({ type: "state", ...this.state });
            case "Page.javascriptDialogOpening":
                this.dialogSeq += 1;
                this.pendingDialog = {
                    id: this.dialogSeq, kind: params.type, message: params.message ?? "",
                    defaultPrompt: params.defaultPrompt ?? "", origin: originOf(params.url),
                };
                this.#broadcast({ type: "dialog", ...this.pendingDialog });
                this.emit("dialog");
                return;
            case "Page.javascriptDialogClosed":
                this.pendingDialog = null;
                return this.#broadcast({ type: "dialogClosed" });
            case "Page.fileChooserOpened":
                return this.notifyError(BrowserErrorCode.FILE_CHOOSER_REJECTED, "File uploads are not supported in browser tabs");
            case "Inspector.targetCrashed":
                return this.close("crashed");
        }
    }

    async #refreshState() {
        // loading turns false before the title arrives; settle() has to wait for it.
        this.refreshing++;
        try {
            await this.#readHistory();
        } finally {
            this.refreshing--;
        }
    }

    async #readHistory() {
        const { currentIndex, entries } = await this.send("Page.getNavigationHistory");
        const entry = entries?.[currentIndex];
        if (!entry) return;
        this.state = {
            ...this.state,
            url: entry.url,
            title: entry.title ?? "",
            canGoBack: currentIndex > 0,
            canGoForward: currentIndex < entries.length - 1,
        };
        this.#broadcast({ type: "state", ...this.state });
        this.emit("change");
    }

    async #viewerResize(ws, size) {
        const viewer = this.viewers.find((v) => v.ws === ws);
        if (!viewer) return;
        viewer.size = clampViewport(size);
        if (this.viewers[0] === viewer) await this.#applyViewport(viewer.size);
    }

    async #applyViewport(size) {
        this.viewport = clampViewport(size);
        const [metrics, stop, start] = viewportCalls(this.viewport);
        await this.send(metrics.method, metrics.params);
        if (!this.screencasting) return;
        await this.send(stop.method, stop.params);
        // The last viewer may have left while the stop was in flight.
        if (this.screencasting) await this.send(start.method, start.params);
    }

    async #startScreencast() {
        this.screencasting = true;
        try {
            await this.send("Page.startScreencast", { ...SCREENCAST, maxWidth: this.viewport.width, maxHeight: this.viewport.height });
        } catch (err) {
            // Fails while the page is swapping its render frame during the first navigation; a later navigation event retries.
            this.screencasting = false;
            logger.warn("Browser screencast start failed", { session: this.id, error: err.message });
        }
    }

    async #resumeScreencast() {
        if (this.viewers.length > 0 && !this.screencasting && !this.closed) await this.#startScreencast();
    }

    #onFrame({ data, sessionId: frameId }) {
        if (this.closed) return;
        this.seq = nextSeq(this.seq);
        const frame = encodeFrame(this.seq, Buffer.from(data, "base64"));
        const recipients = [];
        for (const viewer of this.viewers) {
            if (viewer.ws.readyState !== 1) continue;
            if (viewer.ws.bufferedAmount > this.bufferLimit) {
                viewer.stalled = true;
                continue;
            }
            viewer.stalled = false;
            viewer.ws.send(frame, { binary: true });
            recipients.push(viewer);
        }
        this.#ackWhenDrained(frameId, recipients, Date.now());
    }

    #ackWhenDrained(frameId, recipients, startedAt) {
        if (this.closed) return;
        const lagging = recipients.filter((v) => !v.stalled && v.ws.readyState === 1 && v.ws.bufferedAmount > this.bufferLimit);
        if (lagging.length > 0 && Date.now() - startedAt < this.stallMs) {
            setTimeout(() => this.#ackWhenDrained(frameId, recipients, startedAt), ACK_POLL_MS);
            return;
        }
        // Waiting forever for a viewer that never drains would stop the stream for every other viewer.
        for (const viewer of lagging) viewer.stalled = true;
        this.send("Page.screencastFrameAck", { sessionId: frameId }).catch(() => {});
    }

    #agentMessage() {
        return { type: "agent", active: this.agentTool !== null, tool: this.agentTool, paused: this.agentPaused };
    }

    #dialogError() {
        return new BrowserError(BrowserErrorCode.DIALOG_PENDING,
            `Waiting for the user to answer a page ${this.pendingDialog.kind} dialog: "${this.pendingDialog.message}"`);
    }

    #closedError() {
        return new BrowserError(BrowserErrorCode.SESSION_CLOSED, `Browser session ${this.id} has ended (${this.closeReason})`);
    }

    #sendTo(ws, message) {
        if (ws.readyState === 1) ws.send(JSON.stringify(message));
    }

    #broadcast(message) {
        const payload = JSON.stringify(message);
        for (const { ws } of this.viewers) if (ws.readyState === 1) ws.send(payload);
    }
}

module.exports = { BrowserSession };

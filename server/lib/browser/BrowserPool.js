const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { CdpConnection } = require("./cdp");
const { BrowserSession } = require("./BrowserSession");
const { assertNavigableUrl } = require("./input");
const { BrowserError, BrowserErrorCode } = require("./errors");
const logger = require("../../utils/logger");

const DOWNLOAD_PATH = "/downloads";
const SWEEP_INTERVAL_MS = 60 * 1000;
const PERSISTENT_LINGER_MS = 60 * 1000;
const PROFILES = new Set(["ephemeral", "persistent"]);

class BrowserPool extends EventEmitter {
    constructor({ getSettings, launcher, connectCdp = (url) => CdpConnection.connect(url), createVia, persistentLingerMs = PERSISTENT_LINGER_MS }) {
        super();
        Object.assign(this, { getSettings, launcher, connectCdp, createVia, persistentLingerMs });
        this.sessions = new Map();
        this.instances = new Map();
        this.live = new Map();
        this.retiring = new Map();
        this.downloads = new Map();
        this.opening = 0;
        this.reconciled = Promise.resolve();
    }

    get(sessionId) {
        return this.sessions.get(sessionId)?.session ?? null;
    }

    getOwned(accountId, sessionId) {
        const session = this.get(sessionId);
        return session && session.accountId === accountId ? session : null;
    }

    listForAccount(accountId) {
        return [...this.sessions.values()]
            .filter(({ session }) => session.accountId === accountId)
            .map(({ session }) => session.summary());
    }

    async close(sessionId, reason) {
        this.get(sessionId)?.close(reason);
    }

    reconcile() {
        // A fresh process owns no session; every non-default instance a previous process left is an orphan.
        this.reconciled = (async () => {
            if (!(await this.getSettings()).enabled) return;
            const running = await this.launcher.list();
            await Promise.all(running.filter(({ key }) => key !== "default").map(({ key }) => this.launcher.stop(key)));
        })().catch((err) => logger.warn("Browser instance cleanup failed", { error: err.message }));
        return this.reconciled;
    }

    async removeAccount(accountId) {
        for (const { session } of [...this.sessions.values()])
            if (session.accountId === accountId) session.close("account deleted");
        // The launcher stops the instance and waits for it before deleting the profile directory.
        await this.launcher.removeProfile(`account-${accountId}`);
    }

    async open({ accountId, url, profile = "ephemeral", via = null, origin = "agent" }) {
        const href = url == null ? null : assertNavigableUrl(url);
        if (!PROFILES.has(profile))
            throw new BrowserError(BrowserErrorCode.INVALID_PROFILE, `Unknown profile "${profile}"; use "ephemeral" or "persistent"`);
        if (via && href === null)
            throw new BrowserError(BrowserErrorCode.INVALID_ARGUMENT, "via tunnels the host of a URL; pass a url together with via.");
        if (via && profile === "persistent")
            throw new BrowserError(BrowserErrorCode.VIA_PERSISTENT,
                "via and a persistent profile exclude each other: a Chromium profile directory can only be held by one instance, and via needs an instance of its own. Leave out profile; a via session always runs ephemeral.");
        const settings = await this.getSettings();
        if (!settings.enabled)
            throw new BrowserError(BrowserErrorCode.UNAVAILABLE,
                "Browser tabs are not enabled. The outpost-browser container has to run, and an administrator has to enable it under Settings > Browser.");
        if (this.sessions.size + this.opening >= settings.maxSessions) {
            const own = this.listForAccount(accountId);
            throw new BrowserError(BrowserErrorCode.LIMIT_REACHED, own.length > 0
                ? `The limit of ${settings.maxSessions} concurrent browser sessions is reached. Close one of yours with browser_close first.`
                : `The limit of ${settings.maxSessions} concurrent browser sessions is reached by other accounts. Try again later or ask an administrator to raise it under Settings > Browser.`,
            { sessions: own });
        }

        this.opening++;
        let counted = true;
        const id = `browser-${randomUUID()}`;
        const instanceKey = via ? `via-${id.slice("browser-".length)}` : profile === "persistent" ? `account-${accountId}` : "default";
        let viaHandle = null;
        let instance = null;
        let browserContextId = null;
        try {
            if (via) viaHandle = await this.createVia({ accountId, via, url: href, settings });
            const kind = via ? "ephemeral" : profile === "persistent" ? "persistent" : "default";
            instance = await this.#instance(instanceKey, { kind, hostResolverRules: viaHandle?.resolverRule ?? null });
            // Reserved before the next await: a session closing meanwhile must not retire the instance under us.
            instance.users.add(id);
            clearTimeout(instance.lingerTimer);
            // The tunnel belongs to the instance, so a popup of the page keeps it after its opener closed.
            if (viaHandle) instance.viaHandle = viaHandle;
            const ownsContext = !via && profile === "ephemeral";
            if (ownsContext) {
                ({ browserContextId } = await instance.cdp.send("Target.createBrowserContext", { disposeOnDetach: true }));
                await instance.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_PATH, browserContextId, eventsEnabled: true });
            }
            const session = await this.#attach(instance, {
                id, accountId, profile: via ? "ephemeral" : profile, via: viaHandle?.label ?? null, origin,
                organizationId: viaHandle?.organizationId ?? null, browserContextId,
            });
            this.#register(session, instance, { ownsContext, browserContextId });
            this.opening--;
            counted = false;
            let navigationError = null;
            if (href) await session.navigate(href).catch((err) => {
                navigationError = err.message;
            });
            return { session, navigationError };
        } catch (err) {
            if (instance) {
                if (browserContextId) instance.cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
                this.#release(instance, id);
            } else {
                viaHandle?.close();
                if (via) this.#stopInstance(instanceKey);
            }
            if (err instanceof BrowserError) throw err;
            throw new BrowserError(BrowserErrorCode.UNAVAILABLE,
                `The browser container is not reachable (${err.message}). It has to run and answer under the launcher address in Settings > Browser.`);
        } finally {
            if (counted) this.opening--;
        }
    }

    sweepIdle(idleMs, now = Date.now()) {
        for (const { session } of [...this.sessions.values()])
            if (session.viewers.length === 0 && now - session.lastActivity >= idleMs) session.close("idle");
    }

    startSweeper() {
        const timer = setInterval(() => {
            this.getSettings().then((settings) => this.sweepIdle(settings.idleMinutes * 60 * 1000))
                .catch((err) => logger.warn("Browser idle sweep failed", { error: err.message }));
        }, SWEEP_INTERVAL_MS);
        timer.unref?.();
        return timer;
    }

    #instance(key, { kind, hostResolverRules }) {
        if (!this.instances.has(key)) {
            const starting = (async () => {
                await this.reconciled;
                await this.retiring.get(key);
                const { port } = await this.launcher.start({ key, kind, hostResolverRules });
                const cdp = await this.connectCdp(await this.launcher.endpoint(port));
                const instance = { key, cdp, users: new Set(), viaHandle: null };
                cdp.on("event", (event) => {
                    if (event.sessionId) return;
                    this.#onBrowserEvent(instance, event)
                        .catch((err) => logger.warn("Browser instance event failed", { instance: key, method: event.method, error: err.message }));
                });
                cdp.on("close", () => this.#onInstanceLost(instance));
                await cdp.send("Target.setDiscoverTargets", { discover: true });
                await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_PATH, eventsEnabled: true });
                this.live.set(key, instance);
                return instance;
            })();
            this.instances.set(key, starting);
            starting.catch(() => {
                if (this.instances.get(key) === starting) this.instances.delete(key);
            });
        }
        return this.instances.get(key);
    }

    async #attach(instance, { id, accountId, profile, via, origin, organizationId, browserContextId = null, targetId = null }) {
        const target = targetId
            ?? (await instance.cdp.send("Target.createTarget", { url: "about:blank", ...(browserContextId && { browserContextId }) })).targetId;
        let session = null;
        try {
            const { sessionId: cdpSessionId } = await instance.cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
            session = new BrowserSession({ id, accountId, profile, via, origin, organizationId, cdp: instance.cdp, targetId: target, cdpSessionId });
            await session.start();
            return session;
        } catch (err) {
            session?.close("start failed");
            instance.cdp.send("Target.closeTarget", { targetId: target }).catch(() => {});
            throw err;
        }
    }

    #register(session, instance, { ownsContext, browserContextId }) {
        if (session.closed || this.live.get(instance.key) !== instance) {
            session.close("browser instance ended");
            instance.cdp.send("Target.closeTarget", { targetId: session.targetId }).catch(() => {});
            throw new BrowserError(BrowserErrorCode.UNAVAILABLE, "The browser instance ended while the session was starting. Try again.");
        }
        const record = { session, instanceKey: instance.key, ownsContext, browserContextId };
        this.sessions.set(session.id, record);
        instance.users.add(session.id);
        session.on("change", () => this.emit("change", session.accountId));
        session.once("closed", () => this.#onClosed(record, instance)
            .catch((err) => logger.warn("Browser session cleanup failed", { session: session.id, error: err.message })));
        this.emit("change", session.accountId);
    }

    async #onClosed({ session, instanceKey, ownsContext, browserContextId }, instance) {
        this.sessions.delete(session.id);
        this.#forgetDownloads(new Set([session.id]));
        this.emit("change", session.accountId);
        instance.users.delete(session.id);
        if (this.live.get(instanceKey) !== instance) return;
        if (ownsContext) await instance.cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
        else await instance.cdp.send("Target.closeTarget", { targetId: session.targetId }).catch(() => {});
        if (instance.users.size > 0 || instanceKey === "default" || this.live.get(instanceKey) !== instance) return;
        if (instanceKey.startsWith("account-")) this.#retireAfterLinger(instance);
        else await this.#retire(instanceKey);
    }

    // Chromium commits persistent cookies to disk on a timer of about 30 s, not on shutdown.
    #retireAfterLinger(instance) {
        clearTimeout(instance.lingerTimer);
        instance.lingerTimer = setTimeout(() => {
            if (instance.users.size > 0 || this.live.get(instance.key) !== instance) return;
            this.#retire(instance.key).catch((err) => logger.warn("Browser instance retire failed", { instance: instance.key, error: err.message }));
        }, this.persistentLingerMs);
        instance.lingerTimer.unref?.();
    }

    #release(instance, id) {
        instance.users.delete(id);
        if (instance.users.size > 0 || instance.key === "default" || this.live.get(instance.key) !== instance) return;
        if (instance.key.startsWith("account-")) this.#retireAfterLinger(instance);
        else this.#retire(instance.key).catch(() => {});
    }

    #forgetDownloads(sessionIds) {
        for (const [guid, download] of this.downloads) if (sessionIds.has(download.sessionId)) this.downloads.delete(guid);
    }

    #stopInstance(key) {
        const stopping = this.launcher.stop(key)
            .catch((err) => logger.warn("Browser instance stop failed", { instance: key, error: err.message }));
        this.retiring.set(key, stopping);
        stopping.then(() => {
            if (this.retiring.get(key) === stopping) this.retiring.delete(key);
        });
        return stopping;
    }

    async #retire(key) {
        const instance = this.live.get(key);
        clearTimeout(instance?.lingerTimer);
        this.live.delete(key);
        this.instances.delete(key);
        instance?.viaHandle?.close();
        instance?.cdp.close();
        await this.#stopInstance(key);
    }

    #onInstanceLost(instance) {
        if (this.live.get(instance.key) !== instance) return;
        this.live.delete(instance.key);
        this.instances.delete(instance.key);
        instance.viaHandle?.close();
        // The connection can drop while Chromium keeps running; a via key is never asked for again.
        if (instance.key !== "default") this.#stopInstance(instance.key);
        const lost = [...this.sessions.values()].filter(({ instanceKey }) => instanceKey === instance.key).map(({ session }) => session);
        this.#forgetDownloads(new Set(lost.map((session) => session.id)));
        for (const session of lost) session.close("crashed");
    }

    async #onBrowserEvent(instance, { method, params }) {
        const byTarget = (targetId) => [...this.sessions.values()].find((record) => record.session.targetId === targetId);
        switch (method) {
            case "Target.targetCreated": {
                const info = params.targetInfo ?? {};
                const opener = info.type === "page" && info.openerId ? byTarget(info.openerId) : null;
                if (opener && !byTarget(info.targetId)) await this.#adoptPopup(instance, opener, info.targetId);
                return;
            }
            case "Target.targetInfoChanged":
                byTarget(params.targetInfo?.targetId)?.session.applyTargetInfo(params.targetInfo);
                return;
            case "Target.targetDestroyed":
                byTarget(params.targetId)?.session.close("page closed");
                return;
            case "Browser.downloadWillBegin": {
                const record = byTarget(params.frameId);
                if (!record) return;
                this.downloads.set(params.guid, { sessionId: record.session.id, filename: params.suggestedFilename });
                record.session.notifyDownload({ filename: params.suggestedFilename, state: "inProgress" });
                return;
            }
            case "Browser.downloadProgress": {
                const download = this.downloads.get(params.guid);
                if (!download || params.state === "inProgress") return;
                this.downloads.delete(params.guid);
                this.get(download.sessionId)?.notifyDownload({ filename: download.filename, state: params.state });
            }
        }
    }

    async #adoptPopup(instance, opener, targetId) {
        const id = `browser-${randomUUID()}`;
        // Reserved before the first await, as in open(): the opener closing meanwhile must not retire the instance under us.
        instance.users.add(id);
        clearTimeout(instance.lingerTimer);
        let counted = false;
        let registered = false;
        try {
            const settings = await this.getSettings();
            const parent = opener.session;
            if (this.sessions.size + this.opening >= settings.maxSessions) {
                await instance.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
                parent.notifyError(BrowserErrorCode.POPUP_BLOCKED, `The page opened a popup, but the limit of ${settings.maxSessions} browser sessions is reached`);
                return;
            }
            this.opening++;
            counted = true;
            const session = await this.#attach(instance, {
                id, accountId: parent.accountId, profile: parent.profile, via: parent.via,
                origin: parent.origin, organizationId: parent.organizationId, targetId,
            });
            // A popup is often the login the user paused the agent for; it must not arrive unpaused.
            session.agentPaused = parent.agentPaused;
            this.#register(session, instance, { ownsContext: false, browserContextId: null });
            registered = true;
        } finally {
            if (counted) this.opening--;
            if (!registered) this.#release(instance, id);
        }
    }
}

module.exports = { BrowserPool };

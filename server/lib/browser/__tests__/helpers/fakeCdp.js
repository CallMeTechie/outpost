const { EventEmitter } = require("node:events");

const HISTORY = { currentIndex: 0, entries: [{ id: 1, url: "about:blank", title: "" }] };

const createFakeCdp = (responders = {}) => {
    const cdp = new EventEmitter();
    cdp.calls = [];
    cdp.send = async (method, params = {}, sessionId) => {
        cdp.calls.push({ method, params, sessionId });
        const responder = responders[method] ?? (method === "Page.getNavigationHistory" ? HISTORY : undefined);
        return typeof responder === "function" ? responder(params, sessionId) : (responder ?? {});
    };
    cdp.emitEvent = (method, params, sessionId) => cdp.emit("event", { method, params, sessionId });
    cdp.callsOf = (method, sessionId) => cdp.calls.filter((c) => c.method === method && (sessionId === undefined || c.sessionId === sessionId));
    cdp.close = () => cdp.emit("close");
    return cdp;
};

const createFakeViewer = ({ sendCost = 0 } = {}) => ({
    readyState: 1,
    bufferedAmount: 0,
    binary: [],
    json: [],
    closedWith: null,
    send(data, options) {
        if (options?.binary) {
            this.binary.push(data);
            this.bufferedAmount += sendCost;
        } else {
            this.json.push(JSON.parse(data));
        }
    },
    close(code, reason) {
        this.closedWith = { code, reason };
        this.readyState = 3;
    },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { createFakeCdp, createFakeViewer, flush };

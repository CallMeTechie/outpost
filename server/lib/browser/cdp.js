const { EventEmitter } = require("node:events");
const WebSocket = require("ws");

class CdpError extends Error {
    constructor(method, { code, message }) {
        super(`${method}: ${message}`);
        this.name = "CdpError";
        this.code = code;
    }
}

class CdpConnection extends EventEmitter {
    constructor(socket) {
        super();
        // Every session on this connection adds its own "event" listener.
        this.setMaxListeners(0);
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.closed = false;
        socket.on("message", (raw) => this.#onMessage(raw));
        socket.on("close", () => this.#onClose());
        socket.on("error", () => {});
    }

    static connect(url, { WebSocketImpl = WebSocket, timeoutMs = 5000 } = {}) {
        return new Promise((resolve, reject) => {
            const socket = new WebSocketImpl(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
            const timer = setTimeout(() => {
                socket.terminate?.();
                reject(new Error(`CDP connect timeout: ${url}`));
            }, timeoutMs);
            socket.once("open", () => {
                clearTimeout(timer);
                resolve(new CdpConnection(socket));
            });
            socket.once("error", (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    send(method, params = {}, sessionId = undefined) {
        if (this.closed) return Promise.reject(new CdpError(method, { code: -1, message: "connection closed" }));
        const id = this.nextId++;
        const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, method });
            this.socket.send(JSON.stringify(message));
        });
    }

    close() {
        this.socket.close();
    }

    #onMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            return;
        }
        if (message.id !== undefined) {
            const call = this.pending.get(message.id);
            if (!call) return;
            this.pending.delete(message.id);
            if (message.error) call.reject(new CdpError(call.method, message.error));
            else call.resolve(message.result ?? {});
            return;
        }
        if (message.method) this.emit("event", { method: message.method, params: message.params ?? {}, sessionId: message.sessionId });
    }

    #onClose() {
        if (this.closed) return;
        this.closed = true;
        for (const { reject, method } of this.pending.values()) reject(new CdpError(method, { code: -1, message: "connection closed" }));
        this.pending.clear();
        this.emit("close");
    }
}

module.exports = { CdpConnection, CdpError };

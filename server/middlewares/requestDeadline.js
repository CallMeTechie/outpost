const DEFAULT_MS = 300 * 1000;
const TIMED_OUT = "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

// Stands in for server.requestTimeout, which index.js sets to 0: Node cannot lift that limit for a
// single request, and a git push may upload for longer. Only a route that knows who is sending lifts this one.
// An answer alone does not end the deadline: after a 401 or 404 Node keeps reading an unread body on a
// keep-alive connection, without requestTimeout for as long as the client sends.
// The 408 goes to the socket, not through res: finalhandler and routes that wait for this body answer
// afterwards, and with res.headersSent set that answer throws ERR_HTTP_HEADERS_SENT outside any try.
const requestDeadline = ({ ms = DEFAULT_MS } = {}) => (req, res, next) => {
    let timer = setTimeout(() => {
        timer = null;
        const socket = req.socket;
        if (req.complete || !socket || socket.destroyed) return;
        if (res.headersSent) return socket.destroy();
        socket.end(TIMED_OUT, () => socket.destroy());
    }, ms);
    const clear = () => {
        clearTimeout(timer);
        timer = null;
    };
    req.clearRequestDeadline = clear;
    req.once("end", clear);
    res.once("finish", () => {
        if (req.complete) clear();
    });
    res.once("close", () => {
        if (req.complete || req.destroyed) clear();
    });
    next();
};

module.exports = { requestDeadline };

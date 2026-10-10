const express = require("express");
const path = require("node:path");

const HOST_PATTERN = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
const FRAME_ANCESTORS = "frame-ancestors 'self'";

const buildContentSecurityPolicy = ({ host, secure, enforce }) => {
    const sockets = HOST_PATTERN.test(host || "") ? ` ws://${host} wss://${host}` : "";
    return [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src 'self'${sockets}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        ...(enforce ? [FRAME_ANCESTORS] : []),
        "report-uri /api/csp-report",
        ...(secure ? ["report-to csp"] : []),
    ].join("; ");
};

const setContentSecurityPolicy = (req, res, next) => {
    const enforce = process.env.CSP_ENFORCE === "true";
    const policy = buildContentSecurityPolicy({ host: req.get("host"), secure: req.secure, enforce });
    if (enforce) {
        res.setHeader("Content-Security-Policy", policy);
    } else {
        res.setHeader("Content-Security-Policy", FRAME_ANCESTORS);
        res.setHeader("Content-Security-Policy-Report-Only", policy);
    }
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    if (req.secure) res.setHeader("Reporting-Endpoints", "csp=\"/api/csp-report\"");
    next();
};

/**
 * Serves the built client: the static files, then index.html for every client-side route.
 *
 * `/assets` is excluded from that fallback on purpose. Its filenames carry a content hash, so a
 * browser still running a previous build asks for chunks this build no longer ships. Answering
 * those with index.html hands the browser HTML where it expects a JS module: the import fails on
 * the MIME type, the feature dies without a trace, and nothing reaches the server log. A 404 makes
 * a stale tab say so.
 */
const mountStaticSite = (app, distDir) => {
    app.use(setContentSecurityPolicy);

    app.use(express.static(distDir));

    app.get("/assets/*name", (req, res) => res.sendStatus(404));

    app.get("*name", (req, res) => res.sendFile(path.join(distDir, "index.html")));
};

module.exports = { mountStaticSite };

const express = require("express");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const logger = require("../utils/logger");

const app = express.Router();

const MAX_REPORTS = 10;
const MAX_FIELD = 200;
const KEYWORD = /^[a-z-]{1,32}$/i;
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const DIRECTIVES = new Set([
    "default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr",
    "img-src", "font-src", "connect-src", "media-src", "object-src", "frame-src", "child-src", "worker-src",
    "manifest-src", "base-uri", "form-action", "frame-ancestors", "require-trusted-types-for", "trusted-types",
]);
const DISPOSITIONS = new Set(["enforce", "report"]);

const cspReportLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip)}`,
    message: { code: 429, message: "Too many CSP reports" },
    standardHeaders: true,
    legacyHeaders: false,
});

const clip = (value) => (typeof value === "string" ? value.slice(0, MAX_FIELD) : null);

const directiveOf = (value) => {
    if (typeof value !== "string" || value.trim() === "") return null;
    const name = value.trim().split(/\s+/)[0].toLowerCase();
    return DIRECTIVES.has(name) ? name : "[other]";
};

// Query strings carry tokens (?sessionToken= on every WebSocket, ?token= on downloads); a report
// about a blocked socket would otherwise write a live session token into the log.
const stripUrl = (value) => {
    if (typeof value !== "string" || value === "") return null;
    try {
        const url = new URL(value);
        return clip(NETWORK_SCHEMES.has(url.protocol) ? `${url.origin}${url.pathname}` : url.protocol);
    } catch {
        return KEYWORD.test(value) ? value : "[unparsed]";
    }
};

const pick = (raw) => {
    const report = raw && typeof raw === "object" ? raw : {};
    const line = report.lineNumber ?? report["line-number"];
    return {
        document: stripUrl(report.documentURL ?? report["document-uri"]),
        blocked: stripUrl(report.blockedURL ?? report["blocked-uri"]),
        directive: directiveOf(report.effectiveDirective ?? report["effective-directive"] ?? report["violated-directive"]),
        source: stripUrl(report.sourceFile ?? report["source-file"]),
        line: Number.isInteger(line) ? line : null,
        disposition: DISPOSITIONS.has(report.disposition) ? report.disposition : null,
    };
};

const summarizeReports = (body) => {
    if (Array.isArray(body)) {
        return body.filter((entry) => entry?.type === "csp-violation").slice(0, MAX_REPORTS).map((entry) => pick(entry.body));
    }
    if (body && typeof body === "object" && body["csp-report"]) return [pick(body["csp-report"])];
    return [];
};

/**
 * POST /csp-report
 * @summary Receive Content Security Policy violation reports
 * @description Browsers post here when the page violates the Content-Security-Policy(-Report-Only) header. No authentication; rate limited per address. Accepts application/csp-report and application/reports+json.
 * @tags Security
 * @produces application/json
 * @return {object} 204 - Report accepted, empty body
 * @return {object} 429 - Too many reports
 */
app.post("/", cspReportLimiter, express.json({ type: ["application/csp-report", "application/reports+json"], limit: "64kb" }), (req, res) => {
    for (const report of summarizeReports(req.body)) logger.warn("CSP violation", report);
    res.status(204).end();
});

app.use((err, req, res, _next) => res.status(err.status === 413 ? 413 : 400).end());

module.exports = app;
module.exports.summarizeReports = summarizeReports;

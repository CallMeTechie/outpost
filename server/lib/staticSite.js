const express = require("express");
const path = require("node:path");

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
    app.use(express.static(distDir));

    app.get("/assets/*name", (req, res) => res.sendStatus(404));

    app.get("*name", (req, res) => res.sendFile(path.join(distDir, "index.html")));
};

module.exports = { mountStaticSite };

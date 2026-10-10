const { Router } = require("express");

const app = Router();

// The sub-routers share this root: a router-level middleware in one of them would run for every
// vault request, including GET /available and /settings, so guards belong on the routes.
app.use(require("./items"));
app.use(require("./approvals"));
app.use(require("./agentKeys"));
app.use(require("./settings"));

module.exports = app;

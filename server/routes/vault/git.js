const { Router } = require("express");
const { authenticate } = require("../../middlewares/auth");
const { requireVaultEnabled } = require("../../lib/vault/state");
const { createGitProxy } = require("../../lib/vault/gitProxy");

/**
 * GET /vault/git/{host}/{repo}/info/refs
 * @summary Git Proxy
 * @description Smart-HTTP proxy for git keys of agents: GET info/refs?service=git-upload-pack|git-receive-pack and POST git-upload-pack|git-receive-pack below /vault/git/{host}/{repo}/. Outpost sends the token of the vault entry with Git enabled for this host; the token never reaches the server. Every other path answers 404.
 * @tags Vault
 * @security BearerAuth
 * @param {string} host.path.required - Git host, optionally with a non-default port
 * @param {string} repo.path.required - Repository path, 1 to 8 segments
 * @return {string} 200 - Git advertisement or pack data
 */
const createGitRouter = (proxy = createGitProxy()) => {
    const app = Router();
    app.use("/git", authenticate, requireVaultEnabled, proxy.handle);
    return app;
};

module.exports = createGitRouter();
module.exports.createGitRouter = createGitRouter;

const { BrowserPool } = require("./BrowserPool");
const { createLauncherClient } = require("./launcher");
const { createEngineVia } = require("./proxy");

let pool = null;

const getBrowserPool = () => {
    if (pool) return pool;
    const BrowserSettings = require("../../models/BrowserSettings");
    const getSettings = () => BrowserSettings.getOrCreate();
    const launcher = createLauncherClient(async () => (await getSettings()).launcherUrl);
    pool = new BrowserPool({ getSettings, launcher, createVia: (options) => createEngineVia({ ...options, launcher }) });
    pool.reconcile();
    pool.startSweeper();
    return pool;
};

const removeAccount = async (accountId) => {
    if (pool) return pool.removeAccount(accountId);
    // The CLI deletes accounts too; building a pool there would run reconcile() and stop the server's instances.
    const BrowserSettings = require("../../models/BrowserSettings");
    const launcher = createLauncherClient(async () => (await BrowserSettings.getOrCreate()).launcherUrl);
    await launcher.removeProfile(`account-${accountId}`);
};

module.exports = { getBrowserPool, removeAccount };

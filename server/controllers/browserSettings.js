const BrowserSettings = require("../models/BrowserSettings");

const FIELDS = ["enabled", "launcherUrl", "callbackHost", "maxSessions", "idleMinutes"];
const pick = (settings) => Object.fromEntries(FIELDS.map((field) => [field, settings[field]]));

module.exports.getBrowserSettings = async () => pick(await BrowserSettings.getOrCreate());

module.exports.updateBrowserSettings = async (values) => {
    const settings = await BrowserSettings.getOrCreate();
    await settings.update(values);
    return pick(settings);
};

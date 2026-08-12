const Sequelize = require("sequelize");
const db = require("../utils/database");

// Encryption of clientSecret happens in server/lib/microsoft/tokenCrypto.js at the call site, not
// in a hook — see the comment there for why hooks do not fire in this codebase.
module.exports = db.define("microsoft_apps", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, allowNull: false, primaryKey: true },
    clientId: { type: Sequelize.STRING, allowNull: false },
    clientSecret: { type: Sequelize.STRING, allowNull: true },
    clientSecretIV: { type: Sequelize.STRING, allowNull: true },
    clientSecretAuthTag: { type: Sequelize.STRING, allowNull: true },
    redirectUri: { type: Sequelize.STRING, allowNull: false },
    enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
}, {
    freezeTableName: true,
    createdAt: false,
    updatedAt: false,
});

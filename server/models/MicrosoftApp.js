const Sequelize = require("sequelize");
const db = require("../utils/database");

// Encryption of clientSecret happens in server/lib/microsoft/tokenCrypto.js at the call site, not
// in a hook — see the comment there for why hooks do not fire in this codebase.
module.exports = db.define("microsoft_apps", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, allowNull: false, primaryKey: true },
    clientId: { type: Sequelize.STRING, allowNull: false },
    // TEXT for the same reason as the refresh token in MicrosoftConnection: hex-encoded ciphertext
    // doubles the length, so VARCHAR(255) would cap the secret at 127 bytes. IV and auth tag are
    // fixed-length hex and stay STRING.
    clientSecret: { type: Sequelize.TEXT, allowNull: true },
    clientSecretIV: { type: Sequelize.STRING, allowNull: true },
    clientSecretAuthTag: { type: Sequelize.STRING, allowNull: true },
    redirectUri: { type: Sequelize.STRING, allowNull: false },
    enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
}, {
    freezeTableName: true,
    createdAt: false,
    updatedAt: false,
});

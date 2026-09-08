const Sequelize = require("sequelize");
const db = require("../utils/database");

module.exports = db.define("file_pane_states", {
    id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
    accountId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "accounts", key: "id" },
        onDelete: "CASCADE",
    },
    entryId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "entries", key: "id" },
        onDelete: "CASCADE",
    },
    // No `references` here on purpose - see the migration for why.
    identityId: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    lastPath: { type: Sequelize.STRING(1024), allowNull: false },
}, {
    freezeTableName: true,
    timestamps: true,
    // Load-bearing, not documentation. Model.upsert derives its ON CONFLICT target from the model's
    // own unique indexes (sequelize/lib/dialects/abstract/query-interface.js). Without this block the
    // target falls back to the primary key and every write after the first throws
    // SequelizeUniqueConstraintError - which paneStateStore swallows into a log line, so nothing
    // turns red and the pane silently stops remembering. Do not remove it because "the migration
    // already creates the index".
    indexes: [{ unique: true, fields: ["accountId", "entryId", "identityId"] }],
});

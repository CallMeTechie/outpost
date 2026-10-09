module.exports = {
    async up(queryInterface, Sequelize) {
        const { STRING, DATE, INTEGER, BOOLEAN } = Sequelize;

        const tables = await queryInterface.showAllTables();
        if (tables.map((t) => t.toLowerCase?.() || t).includes("browser_settings")) return;

        await queryInterface.createTable("browser_settings", {
            id: { type: INTEGER, primaryKey: true, autoIncrement: true },
            enabled: { type: BOOLEAN, allowNull: false, defaultValue: false },
            launcherUrl: { type: STRING, allowNull: false, defaultValue: "http://outpost-browser:9300" },
            callbackHost: { type: STRING, allowNull: false, defaultValue: "outpost" },
            maxSessions: { type: INTEGER, allowNull: false, defaultValue: 4 },
            idleMinutes: { type: INTEGER, allowNull: false, defaultValue: 30 },
            createdAt: { type: DATE, allowNull: true },
            updatedAt: { type: DATE, allowNull: true },
        });
    },
};

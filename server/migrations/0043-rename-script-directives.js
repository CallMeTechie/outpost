// The directive namespace moved from OUTPOST to OUTPOST. Stored user scripts carry
// both the input directives (@OUTPOST:STEP) and the shell variables the generated
// script writes into (OUTPOST_CONFIRM_RESULT), so both have to move with them.
const renameDirectives = (text) =>
    text.replace(/@OUTPOST:/g, "@OUTPOST:")
        .replace(/\bOUTPOST_([A-Z]+_RESULT)\b/g, "OUTPOST_$1");

const revertDirectives = (text) =>
    text.replace(/@OUTPOST:/g, "@OUTPOST:")
        .replace(/\bOUTPOST_([A-Z]+_RESULT)\b/g, "OUTPOST_$1");

const COLUMNS = [
    { table: "scripts", column: "content" },
    { table: "snippets", column: "command" },
];

// Raw SQL on purpose: Script and Snippet both define model hooks that do not fire
// reliably on a bulk update, and a model-based path would silently bypass them.
const rewrite = async (queryInterface, transform, needle) => {
    for (const { table, column } of COLUMNS) {
        const rows = await queryInterface.sequelize.query(
            `SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE ?`,
            { replacements: [`%${needle}%`], type: queryInterface.sequelize.QueryTypes.SELECT },
        );
        for (const { id, value } of rows) {
            if (!value) continue;
            const next = transform(value);
            if (next === value) continue;
            await queryInterface.sequelize.query(
                `UPDATE ${table} SET ${column} = ? WHERE id = ?`,
                { replacements: [next, id] },
            );
        }
    }
};

module.exports = {
    async up(queryInterface) {
        await rewrite(queryInterface, renameDirectives, "OUTPOST");
    },
    async down(queryInterface) {
        await rewrite(queryInterface, revertDirectives, "OUTPOST");
    },
    renameDirectives,
    revertDirectives,
};

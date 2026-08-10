import js from "@eslint/js";
import globals from "globals";

export default [
    {
        // The only entry that matters against files: ["server/**/*.js"]: without
        // it, eslint . reports 2 findings in server/lib/generated/*.js. The other
        // former entries (node_modules, client, mobile, dist) can never match that
        // pathspec and were dead weight.
        ignores: ["**/generated/**"],
    },
    {
        files: ["server/**/*.js", "scripts/**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: { ...globals.node },
        },
        // An eslint-disable directive that no longer suppresses anything is a stale
        // claim about the code - e.g. "this arg is still unused" after a later change
        // starts reading it. Failing the lint run on that mismatch beats relying on
        // someone noticing and removing the directive by hand.
        linterOptions: {
            reportUnusedDisableDirectives: "error",
        },
        rules: {
            ...js.configs.recommended.rules,

            // Flags the deliberate control-character guards that keep names from
            // wrecking the display - server/lib/tmux/commands.js, controllers/tmux.js
            // and lib/ConnectionService.js all match on purpose.
            "no-control-regex": "off",

            // Every empty block in the server is an empty catch, used on purpose.
            "no-empty": ["error", { allowEmptyCatch: true }],

            // ignoreRestSiblings covers `const { secret: _, ...rest } = obj`, the
            // idiomatic way to drop a key. caughtErrors: "none" keeps an unused
            // `catch (error)` from counting as a defect.
            "no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
            ],
        },
    },
];

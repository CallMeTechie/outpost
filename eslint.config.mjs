import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: [
            "**/node_modules/**",
            "**/generated/**",
            "client/**",
            "mobile/**",
            "dist/**",
        ],
    },
    {
        files: ["server/**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: { ...globals.node },
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

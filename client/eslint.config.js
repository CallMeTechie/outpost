import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  { ignores: ['dist'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    settings: { react: { version: '18.3' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/jsx-no-target-blank': 'off',

      // React 19 removed PropTypes from the library. This project uses them in
      // zero files and does not depend on the package, so the rule asks for
      // something that cannot be done here without adding back what React
      // dropped. It accounted for 1523 of 1903 findings.
      'react/prop-types': 'off',

      // Same call as on the server: this flags displayName in TmuxWindowView,
      // which strips control characters out of window names on purpose. The rule
      // objects to the code that solves the very problem it warns about.
      'no-control-regex': 'off',

      // From the React Compiler rule set, and a poor fit for how this app is
      // built: it flags the deliberate reset effects, including the one guarding
      // against a host switch. Kept visible as a warning instead of forcing a
      // rewrite of reviewed code.
      'react-hooks/set-state-in-effect': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
]

import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'target/**', 'src-tauri/**', 'site/**', 'test-results/**', 'node_modules/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Trusted browser UI and its React components.
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // Two effects in App.tsx reset state when they start (security info, find matches).
      // Fix them when App.tsx is split into hooks, then restore this rule to an error.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    // Build scripts, the fixture server, and node:test unit tests.
    files: ['scripts/**/*.mjs', 'tests/**/*.{ts,mjs}', '*.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    // WebdriverIO specs run under Mocha with the `browser` global.
    files: ['tests/desktop/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha, browser: 'readonly' } },
  },
);

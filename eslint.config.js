import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Everything under src-tauri/ except page-scripts/ is Rust, config, or generated.
    ignores: [
      'dist/**',
      '.claude/**',
      'target/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      'site/**',
      'test-results/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Trusted browser UI and its React components.
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: reactHooks.configs.flat.recommended.rules,
  },
  {
    // Scripts Rust injects into or evaluates in website pages (src-tauri/page-scripts).
    // They run as classic scripts in the page's own JavaScript world.
    files: ['src-tauri/page-scripts/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
  {
    // lib.rs replaces this placeholder with `true` (desktop-test builds) or `false`.
    files: ['src-tauri/page-scripts/context-menu.js'],
    languageOptions: { globals: { EXPOSE_MENU_ITEMS: 'readonly' } },
  },
  {
    // Build scripts, the fixture server, and Vitest unit tests.
    files: ['scripts/**/*.mjs', 'tests/**/*.{ts,mjs}', '*.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
  {
    // WebdriverIO specs run under Mocha with the `browser` global.
    files: ['tests/desktop/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.mocha, browser: 'readonly' } },
  },
);

## 2026-10-31 10:34

- Bumped `@vitejs/plugin-react` 5.0.2 -> 5.2.0 (5.0.2 peer range excludes vite 8, which made `npm install` fail with ERESOLVE and left `@dnd-kit/*` uninstalled, breaking `tsc -b`).

## 2026-10-31 10:37

- Stopped tracking generated `src-tauri/gen/schemas/` and ignored it, along with `.idea/`.

## 2026-10-31 10:38

- Added `npm run clean`: removes `dist`, `test-results`, TypeScript build info (`node_modules/.tmp`) and runs `cargo clean`. Leaves `node_modules` installed.

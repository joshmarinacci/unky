## 2026-10-31 10:34

- Bumped `@vitejs/plugin-react` 5.0.2 -> 5.2.0 (5.0.2 peer range excludes vite 8, which made `npm install` fail with ERESOLVE and left `@dnd-kit/*` uninstalled, breaking `tsc -b`).

## 2026-10-31 10:37

- Stopped tracking generated `src-tauri/gen/schemas/` and ignored it, along with `.idea/`.

## 2026-10-31 10:38

- Added `npm run clean`: removes `dist`, `test-results`, TypeScript build info (`node_modules/.tmp`) and runs `cargo clean`. Leaves `node_modules` installed.

## 2026-10-31 11:10

- Tab drag fixes: split overlay no longer preselects a target; only the outer 25% edge bands of the page (and the new-window strip) are drop zones, the page center does nothing.
- The overlay clears its target when the pointer leaves it, and a drag only splits or moves to a new window when it is actually dropped on the overlay (previously the last hovered zone was used, so sidebar reorders/cancels could split).
- Tab drag handle is always visible (dimmed) and larger (24x28px).
- Added Rust unit tests for the drop-zone mapping; the desktop spec now asserts no split without a drop.

## 2026-10-31 11:16

- Tab/folder drag handles are now visually hidden (still focusable for keyboard and screen-reader drags, shown on focus); mouse users drag the whole row. Reverts the earlier always-visible handle.

## 2026-10-31 11:21

- Bookmarks drag and drop: dropping on the middle of a folder row now nests the item (top/bottom quarters mean before/after), no horizontal nudge needed.
- Added a drop indicator (line before/after, highlight for inside) and a drag overlay; rows no longer shift while dragging.
- A dragged folder collapses during the drag so its children are not drop targets (fixes silently ignored drops).
- Collapsed folders auto-expand after hovering 600ms while dragging.
- Added a keyboard sensor and `treeitem` role/`aria-level` on rows.
- New `resolveBookmarkDropZone` / `moveBookmarkToDropZone` in `bookmarkTree.ts` with unit tests.

## 2026-10-31 11:27

- Bookmark edit now happens inline: the Edit button replaces that row in the tree with a name/address form (Save, Cancel, Enter to save, Escape to cancel). The top form is add-only and no longer doubles as the edit form.

## 2026-10-31 11:28

- Removed the always-visible add-bookmark form from the top of the Bookmarks view. A new "Bookmark" toolbar button opens the same inline form (Add/Cancel, Enter, Escape) at the top of the list, matching inline editing. The toolbar wraps so the search box keeps full width.

## 2026-10-31 11:30

- Renamed the app from "My Browser" to "Unky": product name, window and menu titles, UI text, docs, download page and launcher bundle paths. Internal identifiers are unchanged on purpose (crate/binary `my-browser`, bundle identifier `dev.example.my-browser` so the existing profile is kept, `MY_BROWSER_*` env vars, `mybrowser` CLI).

## 2026-10-31 11:34

- Removed the "Personal / Local profile" area from the bottom of the sidebar (markup, unused `MoreHorizontal` import and its CSS).

## 2026-10-31 11:36

- The window title now follows the selected tab ("Page title — Unky", or just "Unky" for a blank/new tab), per window. Uses the sidebar display title, so renamed tabs show their custom name. Added the `core:window:allow-set-title` permission to the main capability.

## 2026-10-31 11:39

- Added a 1px top border to the toolbar so it separates from the native window title bar (toolbar height is unchanged; borders are inside its fixed 64px).

## 2026-10-31 11:39

- Added the same 1px top border to the sidebar (top padding reduced by 1px so content does not shift).

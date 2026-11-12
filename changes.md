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

## 2026-10-31 11:42

- Toolbar spacing no longer changes below 900px wide (removed the `max-width: 900px` toolbar override), so windowed and full-screen padding match.
- The macOS titlebar inset used to position website views and the security popover is now read from AppKit (the shell WebView's top safe-area inset) instead of a fixed 20px, so it is the real titlebar height in windowed mode and 0 in full screen (`titlebar_inset` in `lib.rs`; the popover takes it as a parameter). The fixed 20px left the page view overlapping the bottom of the toolbar in windowed mode. The frontend re-reports bounds on resize, so entering/leaving full screen re-applies it.

## 2026-10-31 11:55

- Tabs view now uses dnd-kit like the bookmarks view: a drop indicator (line before/after, highlight for inside a folder), a drag overlay, folders collapse while dragged, collapsed folders auto-expand after 600ms hover, and keyboard dragging (Space to start, Enter selects the tab). Replaces the React Aria Tree and its visible/hidden drag handles; the stale tree CSS is removed.
- `src/bookmarkTree.ts` helpers are now generic and shared by the bookmark and tab trees.
- Native tab drag overlay is pointer-driven (dnd-kit does not start a native drag session): it no longer accepts pasteboard drops and ignores mouse hits. `set_tab_dragging` takes an optional `cancelled`; a split or new-window move happens only when the drag ends with the pointer in an overlay zone and was not cancelled.

## 2026-10-31 11:57

- Browser chrome text now uses size tokens (`--fs-body/callout/sub/foot`, default 13/12/11/10px, one step larger than the old 12/11/10/9px) instead of hard-coded px. `src/osTextSizes.ts` measures the macOS text-style keywords (`-apple-system-body` etc.) at startup and overrides the tokens when the WebView supports them. Start-page and demo styles are unchanged.

## 2026-10-31 12:00

- Collapsed sidebar is now a 48px icon rail instead of an empty strip: expand button at the top, a + new-tab button below it, one icon per visible tab/folder (favicon or folder icon, active tab highlighted, title on hover), and a developer console toggle at the bottom.
- New `toggle_devtools` command (and permission) opens/closes the web inspector of the window active page; the Tauri `devtools` feature is enabled so it also works in release builds.

## 2026-10-31 12:04

- The context menu now works on the collapsed icon rail and is the same menu as the full-width tabs (rename expands the sidebar first so the inline field is visible; the menu moved out of the sidebar content so it is not hidden while collapsed).
- Tabs view toolbar: **+ Tab** and **Folder** moved to the top of the tabs list, styled like the bookmarks toolbar. **New private tab** stays at the bottom.

## 2026-10-31 12:06

- Address box: the shield (page security popover) now sits at the left end where the lock/globe indicator was, and the bookmark star at the right end where the clear-address "x" was. The clear button is removed (the address is still selected on focus). Both leave the toolbar.
## 2026-11-02

- Added **Help → Show Shortcuts**, which opens an internal keyboard-shortcuts page and reuses its tab when opened again.
- Tab cycling supports `Ctrl+Tab` / `Ctrl+Shift+Tab`, Chrome's `Ctrl+PageDown` / `Ctrl+PageUp` on Windows, and Chrome/Safari tab-cycling shortcuts on macOS. Updated macOS Back/Forward to `⌘[` / `⌘]` to avoid conflicting with Chrome's tab shortcuts.
- Documented the shortcut variants in the README and Windows development guide.

## 2026-11-02

- Reordered the tab context menu: Pin, Reload, New tab below, Duplicate, Split submenu, Move to group, and Close tab. Split directions are nested, with **Unsplit from other tab** available for tabs in a split.
- Added locally persisted pinned-tab state and a pin marker in the tab list. New tabs created from the context menu are inserted below the selected tab.
- Disabled text selection on tab and folder rows while keeping rename inputs selectable, preventing accidental highlighting during right-clicks and drags.

## 2026-11-02

- Settings now opens in a dedicated internal browser tab from the toolbar and native menu. Opening Settings again selects the existing Settings tab; closing it closes that tab.
- Documented the tab-based Settings behavior in the README.

## 2026-11-02

- Clicking inside a website WebView now notifies the trusted browser UI to blur the address field, clearing its focus border. Opening or focusing a tab does not trigger the blur unless the page receives a pointer-down.
- Documented the address-field focus behavior in the README.

## 2026-11-03

- Pinned tabs now move into an icon-only row above the regular tab list. Clicking an icon selects its tab; right-clicking opens the tab context menu, including Unpin. Pin state remains saved across restarts.
- Split-view tabs now share a sidebar row in pane order, with a shared outline and separate selection, close buttons, and context menus. Their icons are also paired in the collapsed sidebar. The presentation preserves folder membership and restores separate rows on unsplit or close. Added grouping tests and a native layout regression for selection, unsplitting, and closing a split tab.
- On macOS, Downloads now opens in a native toolbar popover above the website without shrinking the page. It shows live download status and Show in Finder actions, supports the native View menu, and dismisses on outside clicks or Escape. Added a native regression using a disposable download to check popover updates, dismissal, and unchanged page dimensions.
- Clicking a bookmark folder's name, icon, or row now expands or collapses it. Folder action buttons and the rename field retain their own behavior.
- Replaced the bookmark search field with an accessible search input and an inline clear button that appears while a query is entered.
- Added bookmark-folder context menus with New Bookmark, New Folder, Rename, and Delete Folder. New items are created inside the selected folder; folder deletion uses the existing confirmation for deleting its contents.
- Fixed spaces in bookmark folder names: renaming now disables row dragging and keeps typing events inside the rename field, preventing Space from starting a keyboard drag.
- Bookmark clicks now keep the Bookmarks sidebar selected. Added a bookmark context menu for opening links in new tabs or windows and an **Edit** action for changing a bookmark's name, address, and description. Descriptions persist locally and are included in bookmark search. Added a native regression for opening bookmark links from the trusted UI, private-mode preservation, and URL validation.
- Command-clicking a website link now opens a background tab without changing the selected tab or clearing an existing split view. The new tab preserves the source tab's private mode. Documented the behavior in the README.
- Fixed missing Tauri permissions for the webpage context-menu setting and opening a link in a new window. The setting previously appeared enabled in the UI while Tauri rejected the command, leaving the native menu active. Added a native WebView regression covering enable, disable, navigation, and reload.
- Added **Open Link in New Window** to the custom webpage context menu. It opens the link in a separate browser window and preserves private mode.
- Custom webpage context-menu handling now runs at the window capture phase and stops page handlers when enabled, ensuring the browser menu replaces WebKit's native menu.
- Reapply the saved context-menu setting when a website finishes loading, so the UI preference wins over the default value used while the app starts.
- Added a custom context menu inside website WebViews with navigation, selection, link, image, and copy actions. The menu is enabled by default and can be turned off in **Settings → Webpage context menu** to restore the WebView's default menu.
- Documented the webpage context-menu setting and available actions in the README.

## 2026-11-05

- Tab rows now align nested favicons with their folder icons, keep balanced horizontal padding, expand tab titles when the close button is hidden, and highlight on hover. Clicking a tab-folder row toggles its contents.
- Fixed horizontal overflow in the collapsed sidebar rail, including split-tab icon rows.
- Added **Open Link in Tab Folder** to the website context menu. Its submenu lists folders from the owning browser window's saved tab tree; choosing one opens the link in a new tab inside that folder and preserves the source tab's private mode. Added page-scoped Tauri permissions and a desktop regression for the submenu and folder item.

## 2026-11-09

- Fixed tab URL restoration after navigation inside a page frame.
- Added dated release notes and a release screenshot to the download page and release candidate.

## 2026-11-12

- Separated tab-strip position from bookmarks-sidebar placement. Tabs can dock vertically in the left/right sidebar or horizontally in a compact top/bottom strip, while bookmarks remain in a left/right sidebar. Added separate persisted Settings controls for both positions and expanded the desktop layout regression to cover detached tabs and sidebar geometry.

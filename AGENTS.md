# Repository guidance

## GitHub Actions workflows

- Workflows must only run when manually triggered from the GitHub Actions web interface. Use `workflow_dispatch` as the sole trigger; do not add automatic triggers such as `push`, `pull_request`, or scheduled events.

## macOS desktop browser tests

- For changes that affect the browser UI, website tabs, navigation, or native WebView behavior, run `npm run test:desktop` on macOS.
- This command builds the actual application in debug mode with the `desktop-test` Cargo feature, starts the deterministic localhost fixture, opens the app with a disposable session profile, and runs the WebdriverIO suite through `@wdio/tauri-service`'s embedded macOS provider.
- Review `test-results/child-webview-rendered.png`, `test-results/browser-state.json`, `test-results/frontend-errors.json`, `test-results/network-events.jsonl`, and `test-results/rust-logs.log` after a run. The suite also saves `failure-window.png` when a test fails.
- The Rust DOM inspection command, WDIO plugins, `wdio:` capability, and `desktop-test` frontend plugin import are restricted to debug desktop-test builds. Keep `desktop-test` out of release builds and keep `desktop-test-capability` out of the production capability list.
- The embedded WebDriver only exposes Tauri `WebviewWindow` handles; this browser’s website tabs are child WebViews inside its legacy `Window` and are not separate WebDriver contexts. The debug build adds a hidden `wdio-host` WebviewWindow in the same app process, then inspects real website children through the debug-only `desktop_test_inspect_page` Rust command, which returns their DOM and navigation state.

## Tab splitting and multiple browser windows

- Drag a loaded tab over the page area to show the split targets. Left/right targets split the content horizontally; top/bottom targets split it vertically. The tab list uses dnd-kit (pointer and keyboard sensors, drop indicator, drag overlay) shared with the bookmarks list through the generic helpers in `src/tree.ts`; Space starts a keyboard drag so Enter selects the tab. Because dnd-kit is pointer-based, the native overlay reads the pointer position itself: it only treats the outer 25% edge bands of the page (plus the top-center new-window strip) as drop zones, and `set_tab_dragging` with `dragging: false` splits or moves to a new window only when the pointer ends in a zone and `cancelled` is not true. The frontend passes `cancelled: true` when the drag ends over the sidebar or is cancelled.
- Native split layout is applied to the existing child WebViews. `SplitLayout` records the two ordered tab IDs and orientation; keep the frontend event payload and Rust command return type in sync when changing it.
- Dropping a tab on “New window” creates a `browser-window-*` shell window and reattaches that tab’s child WebView to it. Keep tab snapshots, navigation commands, and window teardown scoped to each tab’s owning window.
- Menu accelerators are app-wide on macOS. Route shortcut, settings, and zoom actions to the focused browser window; do not hard-code the `main` label for these actions.
- For split or window-lifecycle changes, the desktop suite exercises horizontal and vertical split state and moving a child tab to another native browser window. Inspect `test-results/split-view.png` and `test-results/vertical-split.png` alongside the usual browser state and diagnostic artifacts.

## Events, windows and built-in pages

- `onEvent` in `src/ipc.ts` listens only to events sent to the current webview's label. Tauri's default JS `listen` target (`Any`) receives every event whatever window it was sent to, which once made menu shortcuts such as ⌘P run in every window. In Rust, send window-specific events with `emit_to(<window label>, …)`, and app-wide state (downloads, history, bookmarks) to each browser window (`main` and `browser-window-*`) or with `emit`.
- Look up browser windows with `app.get_window`. A browser window holds its UI webview and the page child webviews, and `get_webview_window` finds only single-webview windows. Open new browser windows with `open_browser_window` in `src-tauri/src/windows.rs`, which also closes their tabs when the window is destroyed.
- Built-in pages (Settings, History, Downloads, Shortcuts, Bookmarks) are drawn by the trusted UI over a blank tab, with `unky://<page>` addresses (`src/internalPages.ts`). View Source tabs work the same way, with a `view-source:<url>` address (`src/viewSource.ts`). Their HTML comes from `get_page_source` and is not persisted.
- Tab cycling and ⌘1–⌘9 skip tabs inside collapsed folders (`visibleTabCycleOrder` and `nextVisibleTab` in `src/tabTree.ts`). The UI picks the target and calls `select_tab`, because `cycle_tab` adds any tab missing from its order list back onto the end.
- New shortcuts need a menu item in `src-tauri/src/setup.rs` (id `shortcut-<action>`), a `ShortcutAction` in `src/shortcuts.ts`, a case in `runShortcut` in `src/App.tsx`, an entry in the Windows page-key table in `src-tauri/src/platforms/windows.rs`, a row on the Shortcuts page, and an update to `docs/keyboard-shortcuts.md`. Option-modified shortcuts on macOS (⌥⌘R, ⌥⌘I, ⌥⌘U) are handled only by their menu items, because Option changes `event.key`.

## Tab context menu and rename behavior

- The page custom context menu's “Open Link in Other Split” action must route through the page-authorized `open_link_in_new_tab` command with `otherSplit: true`; website child WebViews cannot invoke trusted-UI commands such as `navigate`.
- New and renamed tab and tab-folder names are selected on input focus so typing replaces the current name.

## Tab UI behavior and tests

- Tab cycling follows pinned-tab order followed by tab-tree order; filter persisted IDs against tabs open in the current window before sending the order to `cycle_tab`.
- Rename inputs for tabs and tab folders select their current text on focus. Keep the shared selection helper covered by the frontend unit suite.
- The webpage context menu can open a link in the opposite split pane or in an installed external browser. Page WebViews may use only explicitly granted commands: browser discovery and external-browser opening are listed in `browser-pages.json` and described in `permissions/browser-link.toml`. Validate page identity and URL in Rust. Any website script can call these commands directly, so every new page command that opens, navigates, focuses, or reads user data must call `authorize_page_action` in `src-tauri/src/page_access.rs` (see `docs/security.md`). Commands live in `src-tauri/src/commands/` by area; `lib.rs` only registers them. Desktop tests that drive pages with synthetic DOM events call the debug-only `desktop_test_simulate_gesture` in place of a real click.
- Unit tests cover tab cycling, split partner selection, rename input selection, external-browser submenu choices, and safe URLs. Use `npm run test:unit` and `cargo test --manifest-path src-tauri/Cargo.toml`.

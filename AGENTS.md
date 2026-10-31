# Repository guidance

## macOS desktop browser tests

- For changes that affect the browser UI, website tabs, navigation, or native WebView behavior, run `npm run test:desktop` on macOS.
- This command builds the actual application in debug mode with the `desktop-test` Cargo feature, starts the deterministic localhost fixture, opens the app with a disposable session profile, and runs the WebdriverIO suite through `@wdio/tauri-service`'s embedded macOS provider.
- Review `test-results/child-webview-rendered.png`, `test-results/browser-state.json`, `test-results/frontend-errors.json`, `test-results/network-events.jsonl`, and `test-results/rust-logs.log` after a run. The suite also saves `failure-window.png` when a test fails.
- The Rust DOM inspection command, WDIO plugins, `wdio:` capability, and `desktop-test` frontend plugin import are restricted to debug desktop-test builds. Keep `desktop-test` out of release builds and keep `desktop-test-capability` out of the production capability list.
- The embedded WebDriver only exposes Tauri `WebviewWindow` handles; this browser’s website tabs are child WebViews inside its legacy `Window` and are not separate WebDriver contexts. The debug build adds a hidden `wdio-host` WebviewWindow in the same app process, then inspects real website children through the debug-only `desktop_test_inspect_page` Rust command, which returns their DOM and navigation state.

## Tab splitting and multiple browser windows

- Drag a loaded tab over the page area to show the split targets. Left/right targets split the content horizontally; top/bottom targets split it vertically. The tab list uses dnd-kit (pointer and keyboard sensors, drop indicator, drag overlay) shared with the bookmarks list through the generic helpers in `src/bookmarkTree.ts`; Space starts a keyboard drag so Enter selects the tab. Because dnd-kit is pointer-based, the native overlay reads the pointer position itself: it only treats the outer 25% edge bands of the page (plus the top-center new-window strip) as drop zones, and `set_tab_dragging` with `dragging: false` splits or moves to a new window only when the pointer ends in a zone and `cancelled` is not true. The frontend passes `cancelled: true` when the drag ends over the sidebar or is cancelled.
- Native split layout is applied to the existing child WebViews. `SplitLayout` records the two ordered tab IDs and orientation; keep the frontend event payload and Rust command return type in sync when changing it.
- Dropping a tab on “New window” creates a `browser-window-*` shell window and reattaches that tab’s child WebView to it. Keep tab snapshots, navigation commands, and window teardown scoped to each tab’s owning window.
- Menu accelerators are app-wide on macOS. Route shortcut, settings, and zoom actions to the focused browser window; do not hard-code the `main` label for these actions.
- For split or window-lifecycle changes, the desktop suite exercises horizontal and vertical split state and moving a child tab to another native browser window. Inspect `test-results/split-view.png` and `test-results/vertical-split.png` alongside the usual browser state and diagnostic artifacts.

# Roadmap

## Active platform

macOS on Apple Silicon is the active development target. The current app is a Tauri 2 browser prototype with native website child WebViews and a React/TypeScript browser interface. Windows and Linux work remains deferred until those platforms can be tested on their native systems.

## Shipped foundation

- Browser shell: create, select, close, restore, and cycle tabs; navigate and search; go back/forward; reload or stop; track page title and loading state.
- Session recovery: restore open tabs, order, selection, URLs, and zoom after restart; reopen up to 20 recently closed tabs.
- Daily browsing: find in page, downloads with progress and reveal, opening links in new tabs, browsing history, bookmarks, and settings.
- Tab organization basics: reorder tabs by dragging, create nested tab folders, move tabs and folders between folders, collapse folders, and rename tabs. Tab folder structure and custom names persist locally.
- Bookmark organization: nested folders, editing, deletion, search, and drag-and-drop reordering.
- Accessible browser chrome: React Aria Components provide interaction primitives; Lucide React supplies UI icons.
- macOS page security popover: show connection state and supported page permission and media information.
- Desktop automation: `npm run test:desktop` exercises the actual app with a disposable profile and deterministic local pages.

Normal browsing still does not have production ad or tracker filtering. Private tabs now use WKWebView's non-persistent data store and are excluded from session recovery, history, and recently closed tabs. Settings can clear website storage for the browser profile and browsing history. Site-specific permission management and per-site data clearing are still unavailable through the current WRY integration.

## Current priorities

### P0: Finish privacy and daily-use gaps

1. **Production content filtering.** Add a curated rule list, safe updates, last-known-good compiled rules, a global setting, and saved per-site exceptions. Keep the shared rule compiler separate from the macOS adapter. The existing rule compiler and macOS fixture do not yet filter normal browsing.
2. **Complete site controls.** The first controls are in place: private tabs use ephemeral WebKit storage, do not enter history/session recovery, and website storage plus history can be cleared from Settings. Still needed: current-site data clearing, supported permission grant/revoke controls, and a retry path that disables filtering for one site once filtering ships.
3. **Authentication compatibility research.** **Research complete:** see [authentication compatibility](authentication-compatibility.md). Validate Apple AutoFill, third-party password providers, and representative passkey flows on supported macOS versions before making compatibility claims.

### P1: Extend tab organization and multitasking

1. **Finish tab organization.** Add pin/unpin and mute controls. Reordering, folders, custom names, and persistence of current tab organization are already implemented.
2. **Split view.** Show two existing tabs at once, with a resizable divider, clear focused-pane state, and keyboard commands routed to the focused pane.
3. **Workspaces.** Add named project groups, move tabs between groups, switch by shortcut, and save workspace organization. Keep workspace grouping distinct from profile identity and cookie storage.
4. **Resource management.** Measure idle CPU and memory before adding unloading; protect audio, downloads, and unsaved work, and include native focus, fullscreen, and accessibility behavior in acceptance checks.
5. **Separate profiles.** Only claim work/personal separation once cookies and website storage are genuinely isolated. Mapping workspaces to profiles depends on that support.

### Later exploration

Import/export, link previews, reader view and page capture, cookie-consent handling, translation, generic web panels, advanced customization, sync, extension compatibility, and optional AI remain in the [browser research backlog](browser-research.md). Keep their scope conditional on evidence and platform feasibility.

## Implementation constraints

- Split view, previews, settings, command overlays, and panels must coordinate native WebView visibility and focus. React overlays alone cannot be assumed to cover or focus native child views correctly.
- Existing versioned session persistence covers tabs and recently closed tabs. Add split, pin, and workspace state through that persistence layer with explicit compatibility handling; do not make localStorage the only durable source of browser state.
- Workspaces group tabs; profiles isolate identity. Do not imply account separation from workspace metadata alone.
- Tauri/WKWebView does not provide Chromium or Firefox extension compatibility. Treat extensions as a separate architecture investigation and do not promise an existing extension catalog.
- Report only filtering, privacy protections, and measurements the app actually provides. A local data reset is not anonymous network routing or deletion of server-side records.

## Deferred platform work

Windows and Linux interception remain deferred because native test machines are not currently available. Before claiming cross-platform filtering, connect WebView2 interception on Windows and a WebKitGTK interception hook on Linux to the website WebView, then verify on each native OS that blocked third-party resources never reach the fixture server while allowed resources do. Revisit this platform gate before broadening filtering support or making cross-platform support claims.

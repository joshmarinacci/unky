# My Browser

A Tauri 2, Rust, React, and TypeScript desktop browser prototype. The app uses one trusted UI WebView and a separate native website WebView for each browser tab.

## Prerequisites

- Node.js 20.19+ or 22.12+, npm
- Rust stable and the platform's Tauri prerequisites
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools and WebView2 Runtime
- Linux: GTK 3, WebKit2GTK 4.1, and the Tauri build dependencies for the target distribution

See the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for distribution-specific packages.

See [Windows development](docs/windows.md) for native builds, keyboard shortcuts,
validation, and remaining platform gaps.

## Run

```sh
npm install
python3 tests/fixtures/server.py
npm run tauri -- dev
```

The local fixture is served on `127.0.0.1:4179`, with its image resources on `127.0.0.1:4180`. The normal app run loads the fixture without enabling filtering; the macOS test command enables the filter compiler and native rule list.

## Release download page

`site/index.html` is a standalone, dependency-free download page. To publish it at `/my-browser/`, upload it as that path's `index.html` and place the macOS disk image beside it with the filename `My-Browser.dmg`; the page's relative download link expects that exact name. Build the disk image on macOS with `npm run tauri -- build --bundles dmg`, then copy and rename the `.dmg` from `src-tauri/target/release/bundle/dmg/`. Update the version and architecture text in the page when publishing a different build. The page includes first-launch guidance for this unnotarized build.

The macOS app icon source is `resources/macos-app-icon.svg`. Regenerate it with `npm run tauri -- icon resources/macos-app-icon.svg --output target/generated-macos-icons`, then copy `target/generated-macos-icons/icon.icns` to `src-tauri/icons/icon.icns`.

## macOS filtering smoke test

After installing dependencies, run `python3 tests/macos_interception_test.py` on macOS. The test enables the `macos-interception-test` Cargo feature, compiles an ABP-style domain rule through `blocker-core` and adblock-rust into a WKContentRuleList, then loads the fixture from `http://127.0.0.1:4179/`. It passes only when the server records `/allowed.png` and does not record `/blocked.png`.

## Browser unit tests

Run the Rust unit tests, including session persistence, history ordering, download names and collision handling, find query escaping, tab cycling, and URL validation, with:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## macOS session integration test

After installing dependencies, run `python3 tests/macos_session_test.py` on macOS to launch the browser with real native WKWebViews. It checks find-in-page matches and misses, waits for a fixture page to finish loading and verifies its favicon appears in the sidebar, opens a `target="_blank"` fixture link in a new native tab, cycles between tabs, downloads and reveals a fixture file, checks history, closes and reopens a tab, then restarts the app and checks session and history recovery. It uses a test-only Cargo feature and temporary session, download, and report paths, not the normal browser profile. The test starts the fixture server on ports `4179` and `4180` itself.

## macOS desktop tests

Run `npm run test:desktop` on macOS after installing dependencies. It builds the debug app with the `desktop-test` feature, starts its localhost fixture on port `4179`, and exercises real child WebViews through the embedded WebDriver with disposable session and history files.

The suite checks navigation, tab switching, horizontal and vertical splits, and moving a tab to another native window. Its private-tab test verifies that normal and private cookies and local storage are isolated, storage survives navigation within a private tab, a fresh private tab starts empty after closing the previous one, and private pages are excluded from in-memory and saved history, saved sessions, and recently closed tabs.

Review the screenshots and diagnostics in `test-results/`, including `private-tab.png`, `private-storage.json`, `child-webview-rendered.png`, `split-view.png`, `vertical-split.png`, `browser-state.json`, `frontend-errors.json`, `network-events.jsonl`, and `rust-logs.log`. The private-tab test calls the tab command directly; it does not automate the menu or keyboard shortcut. Keep the test feature and capability out of release builds.

## Browser interface

The macOS development app has a native menu bar and a React browser interface. It supports multiple website tabs, an address/search bar, back and forward navigation, reload/stop, find-in-page, new-tab links, downloads with progress and reveal, browsing history, tab cycling, a collapsible and resizable sidebar, bookmarks, and a settings page. The address bar tracks client-side URL changes made through the History API and hash navigation. Open tabs, their order and selection, URLs, zoom levels, and up to 20 recently closed tabs are saved in a versioned session file in the app data directory. Browsing history is stored in the app data directory; bookmarks, tab folder structure and custom tab names, the sidebar width and collapsed state, and the appearance preference are stored in the local browser UI's `localStorage`.

The browser chrome uses React Aria Components for accessible controls and interactions, including buttons, text fields, sidebar tabs, tab and bookmark trees, and the appearance selector. Lucide React provides the interface icons. React Aria does not ship a visual theme, so layout and state styling live in `src/style.css`; interactive components use React Aria's state attributes for selection, focus, and drag targets.

### Tabs and folders

Open tabs appear in a vertical list in the sidebar and use the page title and favicon when available. Right-click a tab to rename it, reload it, open its current page in a new private tab, or choose **Move tab to group…** to place it in an existing folder. Reload actions apply to the tab you clicked, even if it is in the background. The custom tab name is saved locally. Use **＋ Folder** to create a folder, then drag tabs or other folders into it. Click the folder triangle to collapse or expand it. Drag rows to reorder them or move them between folders; the highlighted row, insertion line, and folder outline show the current drop target. Deleting a folder removes the folder while keeping its tabs and nested folders in the list.

The find panel opens with `⌘F`, moves keyboard focus to its search field, and reports the number of matches as you type. The toolbar star adds the current page to bookmarks and fills when that page is saved. Bookmark URLs include query parameters, so pages with different queries can be saved separately. The Bookmarks sidebar supports nested folders, renaming, deletion, and drag-and-drop reordering with visual drop indicators.

The toolbar security button opens a macOS native popover for the active page. It reports whether the page is in a validated HTTPS secure context, the page's Location, Camera, and Microphone permission states, and whether an audio or video element is playing. The permission states come from the page's Permissions API; WebKit may report a permission as unavailable when it does not expose that permission type. The popover is anchored to the toolbar button and refreshes while it remains open.

The appearance setting supports System, Light, and Dark. Website zoom is controlled from the View menu and applies to the active tab (50% to 300%, in 10% steps).

### Open the current page in another browser

On macOS, click **Open in another browser** in the toolbar (the arrow leaving a square), or choose **File → Open in Another Browser…**. A native menu lists installed applications registered for HTTPS links that also declare HTML document support, excluding My Browser. This can include browser launchers such as Choosy. Choose a browser to load the current page there; the original tab stays open. The action is disabled for blank tabs.

You can also right-click any loaded tab and choose **Open in another browser…**. This opens the browser picker for that tab without switching to it. Blank tabs have the action disabled; folder menus do not include it.

Only the target tab's current HTTP(S) URL is sent, including its query string and fragment. Cookies, logins, page state, and private mode are not transferred. The receiving browser uses its own session; the picker reminds you of this when opening from a private tab. Browser discovery and launch currently support macOS only.

The trusted UI uses `get_external_browsers` and `open_in_external_browser({ tabId, browserId })`. Rust checks that the tab belongs to the calling window, reads its actual WebView URL, validates it, and resolves the selected browser again before launching it through `/usr/bin/open`. Website tabs cannot invoke these commands. No shell command or application path is accepted from the frontend.

The desktop suite checks discovery, URL preservation, invalid selections, blank pages, window ownership, and opening a background tab without changing the active tab. It captures the validated handoff in `test-results/external-browser-handoff.json` instead of launching a user's browser. This interception requires a debug `desktop-test` build and `MY_BROWSER_TEST_EXTERNAL_OPEN=1`; ordinary app runs launch the selected browser. The suite calls the commands directly; manual UI validation covered the toolbar handoff to Chrome and the context-menu picker on a background tab.

### Private tabs

Open a private tab with **New private tab** below **New tab**, **File → New Private Tab**, or `⌘⇧N`. The existing **Settings → New private tab** action is also available. The tab has a crossed-eye indicator and uses ephemeral website storage separate from normal tabs. Private pages are excluded from browsing history, session recovery, and recently closed tabs; links opened in a new tab inherit the source tab's private mode. Normal tabs remain the default.

The trusted browser UI can request either mode through the existing command:

```ts
await invoke('create_tab'); // Normal tab
await invoke('create_tab', { private: true }); // Private tab
```

The Rust command passes the private flag to Tauri's `WebviewBuilder::incognito`. On macOS this uses a nonpersistent WebKit website data store. Downloaded files and explicitly saved bookmarks remain after a private tab closes. Private mode does not hide network activity from websites or network operators. Native storage isolation is covered by the macOS desktop test; Windows and Linux behavior has not been validated.

### Content filtering (macOS)

Ad and tracker filtering is enabled by default with a small built-in set. In **Settings → Privacy**, turn filtering off or on, update the EasyList source, or disable filtering for the current site. Updates are validated before activation; failed downloads or compilation keep the previous list. Private tabs use the same rules. Only the compiler's supported domain-rule subset is active, so EasyList cosmetic filters, path rules, scriptlets, and redirects are not applied. See [filtering details and limitations](docs/filtering.md).

### Command-line launcher (macOS)

Install the `scripts/mybrowser` launcher into `~/.local/bin` to open the browser with `mybrowser`, or open a URL in a new tab with `mybrowser https://example.com`; add `--private` to create a private tab. Requests are forwarded to the existing app process when it is already running. See [command-line setup](docs/command-line.md).

### macOS shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New tab |
| `⌘⇧N` | New private tab |
| `⌘W` | Close the active tab |
| `⌘⇧T` | Reopen the most recently closed tab |
| `⌘,` | Open Settings |
| `⌘H` | Hide the app |
| `⌥⌘H` | Hide other apps |
| `⌘L` | Focus the address bar |
| `⌘F` | Find in the current page |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `⌘R` | Reload the page |
| `⌥⌘←` / `⌥⌘→` | Back / forward |
| `⌘⇧=` / `⌘-` | Zoom in / out |
| `⌘0` | Reset website zoom |

The Edit menu also provides the standard Undo, Redo, Cut, Copy, Paste, and Select All commands.

## Current status

The browser interface and native website WebViews are implemented for macOS using Tauri's unstable child-WebView API. Production filtering uses WKContentRuleList and the constrained adblock-rust compiler. Windows and Linux interception validation is deferred to a later cross-platform milestone; macOS is the active development platform for now. See [the roadmap](docs/roadmap.md), [filtering details](docs/filtering.md), and [platform matrix](docs/platform-matrix.md). This prototype is not a general-purpose secure browser yet.

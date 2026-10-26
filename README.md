# My Browser

A Tauri 2, Rust, React, and TypeScript desktop browser prototype. The app uses one trusted UI WebView and a separate native website WebView for each browser tab.

## Prerequisites

- Node.js 20.19+ or 22.12+, npm
- Rust stable and the platform's Tauri prerequisites
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools and WebView2 Runtime
- Linux: GTK 3, WebKit2GTK 4.1, and the Tauri build dependencies for the target distribution

See the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for distribution-specific packages.

## Run

```sh
npm install
python3 tests/fixtures/server.py
npm run tauri -- dev
```

The local fixture is served on `127.0.0.1:4179`, with its image resources on `127.0.0.1:4180`. The normal app run loads the fixture without enabling filtering; the macOS test command enables the filter compiler and native rule list.

## macOS filtering smoke test

After installing dependencies, run `python3 tests/macos_interception_test.py` on macOS. The test enables the `macos-interception-test` Cargo feature, compiles an ABP-style domain rule through `blocker-core` and adblock-rust into a WKContentRuleList, then loads the fixture from `http://127.0.0.1:4179/`. It passes only when the server records `/allowed.png` and does not record `/blocked.png`.

## Browser unit tests

Run the Rust unit tests, including session persistence, history ordering, download names and collision handling, find query escaping, tab cycling, and URL validation, with:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## macOS session integration test

After installing dependencies, run `python3 tests/macos_session_test.py` on macOS to launch the browser with real native WKWebViews. It checks find-in-page matches and misses, waits for a fixture page to finish loading and verifies its favicon appears in the sidebar, opens a `target="_blank"` fixture link in a new native tab, cycles between tabs, downloads and reveals a fixture file, checks history, closes and reopens a tab, then restarts the app and checks session and history recovery. It uses a test-only Cargo feature and temporary session, download, and report paths, not the normal browser profile. The test starts the fixture server on ports `4179` and `4180` itself.

## Browser interface

The macOS development app has a native menu bar and a React browser interface. It supports multiple website tabs, an address/search bar, back and forward navigation, reload/stop, find-in-page, new-tab links, downloads with progress and reveal, browsing history, tab cycling, a collapsible and resizable sidebar, bookmarks, and a settings page. The address bar tracks client-side URL changes made through the History API and hash navigation. Open tabs, their order and selection, URLs, zoom levels, and up to 20 recently closed tabs are saved in a versioned session file in the app data directory. Browsing history is stored in the app data directory; bookmarks, tab folder structure and custom tab names, the sidebar width and collapsed state, and the appearance preference are stored in the local browser UI's `localStorage`.

The browser chrome uses React Aria Components for accessible controls and interactions, including buttons, text fields, sidebar tabs, tab and bookmark trees, and the appearance selector. Lucide React provides the interface icons. React Aria does not ship a visual theme, so layout and state styling live in `src/style.css`; interactive components use React Aria's state attributes for selection, focus, and drag targets.

### Tabs and folders

Open tabs appear in a vertical list in the sidebar and use the page title and favicon when available. Right-click a tab to rename it; the custom name is saved locally. Use **＋ Folder** to create a folder, then drag tabs or other folders into it. Click the folder triangle to collapse or expand it. Drag rows to reorder them or move them between folders; the highlighted row, insertion line, and folder outline show the current drop target. Deleting a folder removes the folder while keeping its tabs and nested folders in the list.

The find panel opens with `⌘F`, moves keyboard focus to its search field, and reports the number of matches as you type. The toolbar star adds the current page to bookmarks and fills when that page is saved. Bookmark URLs include query parameters, so pages with different queries can be saved separately. The Bookmarks sidebar supports nested folders, renaming, deletion, and drag-and-drop reordering with visual drop indicators.

The toolbar security button opens a macOS native popover for the active page. It reports whether the page is in a validated HTTPS secure context, the page's Location, Camera, and Microphone permission states, and whether an audio or video element is playing. The permission states come from the page's Permissions API; WebKit may report a permission as unavailable when it does not expose that permission type. The popover is anchored to the toolbar button and refreshes while it remains open.

The appearance setting supports System, Light, and Dark. Website zoom is controlled from the View menu and applies to the active tab (50% to 300%, in 10% steps).

### macOS shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘T` | New tab |
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

The browser interface and native website WebViews are implemented for macOS using Tauri's unstable child-WebView API. The adblock-rust to WKContentRuleList pipeline passes the macOS fixture test for a small domain-rule subset. Windows and Linux interception validation is deferred to a later cross-platform milestone; macOS is the active development platform for now. See [the roadmap](docs/roadmap.md), [filtering scope](docs/filtering.md), and [platform matrix](docs/platform-matrix.md). This prototype is not a general-purpose secure browser yet.

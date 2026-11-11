# Unky

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

See [Full-page screenshots](docs/screenshot-capture.md) for the macOS capture workflow and limits.

## Run

```sh
npm install
python3 tests/fixtures/server.py
npm run tauri -- dev
```

The local fixture is served on `127.0.0.1:4179`, with its image resources on `127.0.0.1:4180`. The normal app run loads the fixture without enabling filtering; the macOS test command enables the filter compiler and native rule list.

Run `npm run clean` to remove build output on both sides: `dist`, `test-results`, the TypeScript build cache, and the Cargo `target` directory (`cargo clean`). It leaves `node_modules` in place.

## Release download page

`site/index.html` is a standalone, dependency-free download page published at [apps.josh.earth/unky](https://apps.josh.earth/unky). It introduces Unky, its values, and its macOS and Windows downloads. Windows x64 and ARM64 installer links are filled from the release artifacts; Windows installers are currently unsigned, and content filtering is available on macOS only. Release candidates generate GitHub release notes from the matching `CHANGELOG.md` section and replace the page's release-notes section with the five newest changelog entries. Website dates come from each GitHub Release's publication date and display in UTC; the current candidate is marked pending until published. The public page updates only after human approval and includes first-launch guidance for macOS.

### Sign and notarize a macOS release

On macOS, run `npm run sign-mac` to build a Developer ID-signed and Apple-notarized DMG. The script checks that the configured Developer ID Application certificate is installed in the login keychain, then prompts for the Apple Account email and app-specific password used for notarization. The password is hidden while typing and is passed to Tauri only for that build; it is not written to the repository. The resulting DMG is in `src-tauri/target/release/bundle/dmg/`. Run this for each release build. The script currently targets Joshua Marinacci's Developer ID identity and team `EYDSR3DT3F`.

The macOS app icon source is `resources/macos-app-icon.svg`. Regenerate it with `npm run tauri -- icon resources/macos-app-icon.svg --output target/generated-macos-icons`, then copy `target/generated-macos-icons/icon.icns` to `src-tauri/icons/icon.icns`.

## macOS filtering smoke test

After installing dependencies, run `python3 tests/macos_interception_test.py` on macOS. The test enables the `macos-interception-test` Cargo feature, compiles an ABP-style domain rule through `blocker-core` and adblock-rust into a WKContentRuleList, then loads the fixture from `http://127.0.0.1:4179/`. It passes only when the server records `/allowed.png` and does not record `/blocked.png`.

## Browser unit tests

Run the Rust unit tests, including session persistence, history ordering, download names and collision handling, find query escaping, tab cycling, and URL validation, with:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Run the frontend tab-layout and tree drag-and-drop unit tests with:

```sh
npm run test:unit
```

These tests cover root reordering, moves between nesting levels and folders, folder nesting, cycle prevention, tab-strip orientation, pinned-tab ordering, and page drag feedback. Tree movement and drop-depth rules live in `src/bookmarkTree.ts`; tab layout and pin ordering helpers live in `src/tabLayout.ts` so the app and tests exercise the same code.

The standalone dnd-kit interaction playground is available at `/?page=tree` while the Vite development server is running (`npm run dev`).

## macOS session integration test

After installing dependencies, run `python3 tests/macos_session_test.py` on macOS to launch the browser with real native WKWebViews. It checks find-in-page matches and misses, waits for a fixture page to finish loading and verifies its favicon appears in the sidebar, opens a `target="_blank"` fixture link in a new native tab, cycles between tabs, downloads and reveals a fixture file, checks history, closes and reopens a tab, then restarts the app and checks session and history recovery. It uses a test-only Cargo feature and temporary session, download, and report paths, not the normal browser profile. The test starts the fixture server on ports `4179` and `4180` itself.

## macOS desktop tests

Run `npm run test:desktop` on macOS after installing dependencies. It builds the debug app with the `desktop-test` feature, starts its localhost fixture on port `4179`, and exercises real child WebViews through the embedded WebDriver with disposable session and history files. The suite covers split and unsplit context-menu actions, start-page split companions, tab duplication and closing, and private-mode preservation.

The suite checks navigation, tab switching, horizontal and vertical splits, and moving a tab to another native window. Its tab-drag regressions verify all four strip positions, pointer-driven tab and folder drops, pin docking and reordering, and native page-edge split feedback. Over a website page, the tab drag card is hidden and the existing AppKit split-target overlay supplies feedback; the test-only overlay inspector checks the selected target. The overlay regression also confirms that the page remains available beneath it and that the overlay is removed when dragging ends. The split-target screenshot is saved as `test-results/tab-drag-split-target.png`. The private-tab test verifies that normal and private cookies and local storage are isolated, storage survives navigation within a private tab, a fresh private tab starts empty after closing the previous one, and private pages are excluded from in-memory and saved history, saved sessions, and recently closed tabs.

Review the screenshots and diagnostics in `test-results/`, including `private-tab.png`, `private-storage.json`, `child-webview-rendered.png`, `tab-drag-overlay.png`, `tab-drag-split-target.png`, `tab-drag-folder-invalid.png`, `split-view.png`, `vertical-split.png`, `browser-state.json`, `frontend-errors.json`, `network-events.jsonl`, and `rust-logs.log`. The drag tests use dnd-kit pointer events and a desktop-test-only native overlay inspector; manual sidebar dragging confirms the full pointer-driven interaction. The private-tab test calls the tab command directly; it does not automate the menu or keyboard shortcut. Keep the test feature and capability out of release builds.

The webpage context-menu regression checks that enabling the setting cancels the context-menu event and displays the browser menu in a native child WebView, disabling it restores the default event, and the setting survives navigation and reload.

## Browser interface

The macOS development app has a native menu bar and a React browser interface. It supports multiple website tabs, an address/search bar, back and forward navigation, reload/stop, find-in-page, new-tab links, downloads with progress and reveal, browsing history, tab cycling, a collapsible and resizable sidebar, bookmarks, and settings. Settings opens in its own internal browser tab from the toolbar or native menu and reuses the existing Settings tab if one is open. **Help → Show Shortcuts** likewise opens an internal page listing browser keyboard shortcuts. Clicking inside a website page blurs the address field so its focus border clears. The address bar tracks client-side URL changes made through the History API and hash navigation. Open tabs, their order and selection, URLs, zoom levels, and up to 20 recently closed tabs are saved in a versioned session file in the app data directory. Browsing history is stored in the app data directory; bookmarks, tab folder structure and custom tab names, pinned-tab order, tab-strip position, the sidebar width and collapsed state, and the appearance preference are stored in the local browser UI's `localStorage`.

The **Settings → Webpage context menu** option replaces each website WebView's default right-click menu with a browser menu. It offers Back, Forward, Reload, and Select All, plus link, image, and Copy actions when they apply. Links can be opened in a new tab or a new window; private links keep their private mode. When tab folders exist, **Open Link in Tab Folder** opens a submenu of folders and creates the new tab inside the chosen folder. The option is enabled by default; turning it off restores the WebView's default context menu.

Command-click a website link to open it in a background tab while keeping the current tab selected. The new tab preserves private mode, and an existing split view stays in place. Command-click works independently of the webpage context-menu setting.

The browser chrome uses React Aria Components for accessible controls and interactions, including buttons, text fields, sidebar tabs, and the appearance selector. The tab and bookmark lists use dnd-kit; tab rows support pointer and keyboard sorting, with Space to start/end a keyboard drag and Escape to cancel. Lucide React provides the interface icons. The controls use the Vanilla CSS starter styles from [React Aria](https://react-aria.adobe.com/getting-started), adapted in `src/react-aria-theme/` for the components this app uses. The starter's orange token supplies the warm accent, and its neutral tokens drive the browser chrome in light and dark themes. `src/style.css` keeps the browser-specific layout and surfaces; React Aria state attributes provide selected and focus styling.

Open recent downloads from the toolbar button at the right end of the navigation bar or choose **View → Show Downloads**. On macOS, Downloads uses a native popover anchored to its toolbar icon, like the shield popover. It floats over the website without resizing the page, shows up to eight recent downloads with live status, and offers **Show in Finder** for completed files. It dismisses on an outside click or Escape and shows **No recent downloads** when empty. Each browser window has its own popover. Other platforms retain the existing Downloads panel. Tabs and Bookmarks are the only sidebar views.

The desktop layout follows the adjacent React Aria mockup's two-column structure: a resizable sidebar sits beside the browser pane, whose navigation and address toolbar sits above the website view. The sidebar defaults to 240 px and can be resized from 176 to 360 px or collapsed to its icon rail. The interface uses neutral surfaces and warm orange selection accents in both light and dark themes. A previously saved sidebar width takes precedence over the default.

### Tabs and folders

The two tabs in a split view share one sidebar row, displayed side by side in pane order within a shared outline. Each tab keeps its own selection, close button, and context menu. The collapsed sidebar likewise pairs their icons. Unsplitting restores separate rows in their original folder locations; closing either tab removes the pair.

Right-click a bookmark folder for **New Bookmark**, **New Folder**, **Rename**, or **Delete Folder**. New bookmarks and subfolders are created inside that folder. Deleting a bookmark folder asks for confirmation before deleting it and its contents.

Clicking a bookmark opens its link while keeping the sidebar on **Bookmarks**. Right-click a bookmark for **Open Link in New Tab**, **Open Link in New Window**, or **Edit**. Edit opens the bookmark's name, address, and description together. Names and descriptions are saved locally; bookmark search includes descriptions. Opening a bookmark in a new tab or window preserves the active tab's private mode.

Choose left, right, top, or bottom from the tab-strip position picker. Left and right positions use a vertical list; top and bottom positions use a horizontal strip. The selected position is saved in the browser UI's `localStorage`. Tabs show the page title and favicon when available. Right-click a tab to pin it, reload it, create a tab below it, duplicate it, split the view in a chosen direction, move it to a group, or close it. Split controls include **Unsplit from other tab** when the tab is already in a split.

Pinned tabs appear in an icon-only dock. Click an icon to select its tab, drag a tab into the dock to pin it, or reorder icons by dragging. Drag a pinned tab back into the tab list to unpin it; right-click an icon for the tab context menu. Pin order is saved in `localStorage`. Tab and folder rows do not select text during right-clicks and drags, while their rename fields remain selectable. Use **＋ Folder** to create a folder, then drag tabs or other folders into it. Click a folder row or its triangle to collapse or expand it. Nested tab icons align with their folder icon; unselected tab names use the available row width and tab rows highlight on hover. Drag rows to reorder them or move them between folders; insertion lines and folder outlines show the current drop target. Deleting a folder removes the folder while keeping its tabs and nested folders.

Collapsing the sidebar leaves a 48 px icon rail: the expand button at the top, a **+** button for a new tab, one icon per visible tab or folder (click to select a tab or toggle a folder; hover for the title), and a button at the bottom that toggles the web inspector for the active page. The inspector is enabled in release builds through Tauri's `devtools` feature, which uses a private macOS API.

The find panel opens with `⌘F`, moves keyboard focus to its search field, and reports the number of matches as you type. The star at the right end of the address box adds the current page to bookmarks and fills when that page is saved. Bookmark URLs include query parameters, so pages with different queries can be saved separately. The Bookmarks sidebar supports nested folders, renaming, deletion, search, and whole-row drag-and-drop. Visible rows sort live while dragging; vertical position controls the insertion point, and horizontal movement changes the nesting depth. When dragging over a shallower row, the item defaults to that row's level unless the horizontal movement indicates that it should nest into a folder. Folder controls and bookmark actions remain independently clickable.

### Native tab drag feedback

On macOS, dragging a tab over the page hides the floating tab card and activates a native AppKit overlay above the website WebView that was active when dragging began. The page remains visible beneath the translucent orange target outline. The outer 25% edge bands select left, right, top, or bottom split targets; left/right split side by side, while top/bottom stack the pages. The top-center strip selects **New window**. Dropping in the page center, over the sidebar, or cancelling the drag does not split or move the tab. The source tab and destination page are captured at drag start, so selecting the dragged row during the gesture cannot redirect the drop. Dropping over a different tab's WebView splits the two loaded pages. Dropping over the dragged tab's own WebView creates a new tab that shows the standard **Where to?** start page in the companion pane. The tab context menu also offers four split directions; splitting the active tab creates a start-page companion, while splitting another tab pairs it with the active page. Tabs in a split have an **Unsplit from other tab** context action, and the toolbar's **Close split view** action clears the pair. Tab context menus also let you duplicate or close a tab; duplicates retain private mode. Selecting either split pane keeps the layout. Selecting a tab outside the split shows that page alone and retains the split pair; selecting one of its panes restores the split. Releasing the drag removes the overlay and sends the selected action to the browser UI. A native timer tracks the pointer while the overlay is active, so target updates do not depend on the website receiving drag events. Pressing Escape cancels the drag without splitting. Other platforms use the same dnd-kit tab list without this macOS native preview.

On macOS, choosing WebKit's **Open Link in New Window** context-menu action opens the link in a new tab in the current browser window. The new tab inherits the source tab's private mode. WebKit's menu label still says “Open Link in New Window,” but the app routes that request to a tab. Requests are limited to HTTP and HTTPS addresses without embedded credentials.

Split layouts are scoped to their browser window, so separate windows can keep independent pane pairs. On macOS, when two pages are split, the active page has a bright warm outline and the other page has a subtle outline. Drag the native divider handle to resize the panes; each pane stays between 20% and 80% of the available content area. The divider and outlines sit above the website WebViews while clicks elsewhere continue to reach the page. The native divider overlay currently appears for one split window at a time. On other platforms, split panes remain equal in size and there is no native divider handle.

The shield at the left end of the address box opens a macOS native popover for the active page. It reports whether the page is in a validated HTTPS secure context, the page's Location, Camera, and Microphone permission states, and whether an audio or video element is playing. The permission states come from the page's Permissions API; WebKit may report a permission as unavailable when it does not expose that permission type. The popover is anchored to the toolbar button and refreshes while it remains open.

The appearance setting supports System, Light, and Dark. Website zoom is controlled from the View menu and applies to the active tab (50% to 300%, in 10% steps).

Choose **View → Show History** to create or activate a browser tab titled `history`. Search by page title or URL, then select an entry to navigate that tab to the page. Private pages are not recorded in history.

History updates, including clearing browsing data, are broadcast to every open browser window so an open History view stays current when another window visits a page.

### Open the current page in another browser

On macOS, click **Open in another browser** in the toolbar (the arrow leaving a square), or choose **File → Open in Another Browser…**. A native menu lists installed applications registered for HTTPS links that also declare HTML document support, excluding Unky. This can include browser launchers such as Choosy. Choose a browser to load the current page there; the original tab stays open. The action is disabled for blank tabs.

You can also right-click any loaded tab and choose **Open in another browser…**. This opens the browser picker for that tab without switching to it. Blank tabs have the action disabled; folder menus do not include it.

Only the target tab's current HTTP(S) URL is sent, including its query string and fragment. Cookies, logins, page state, and private mode are not transferred. The receiving browser uses its own session; the picker reminds you of this when opening from a private tab. Browser discovery and launch currently support macOS only.

The trusted UI uses `get_external_browsers` and `open_in_external_browser({ tabId, browserId })`. Rust checks that the tab belongs to the calling window, reads its actual WebView URL, validates it, and resolves the selected browser again before launching it through `/usr/bin/open`. Website tabs cannot invoke these commands. No shell command or application path is accepted from the frontend.

The desktop suite checks discovery, URL preservation, invalid selections, blank pages, window ownership, and opening a background tab without changing the active tab. It captures the validated handoff in `test-results/external-browser-handoff.json` instead of launching a user's browser. This interception requires a debug `desktop-test` build and `MY_BROWSER_TEST_EXTERNAL_OPEN=1`; ordinary app runs launch the selected browser. The suite calls the commands directly; manual UI validation covered the toolbar handoff to Chrome and the context-menu picker on a background tab.

### Private tabs

Open a private tab with **New private tab** at the bottom of the tabs list, **File → New Private Tab**, or `⌘⇧N`. The existing **Settings → New private tab** action is also available. The tab has a crossed-eye indicator and uses ephemeral website storage separate from normal tabs. Private pages are excluded from browsing history, session recovery, and recently closed tabs; links opened in a new tab inherit the source tab's private mode. Normal tabs remain the default.

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
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab (Safari and Chrome) |
| `⌘⌥→` / `⌘⌥←` | Next / previous tab (Chrome) |
| `⇧⌘]` / `⇧⌘[` | Next / previous tab (Safari) |
| `⌘R` | Reload the page |
| `⌘[` / `⌘]` | Back / forward |
| `⌘⇧=` / `⌘-` | Zoom in / out |
| `⌘0` | Reset website zoom |

The Edit menu also provides the standard Undo, Redo, Cut, Copy, Paste, and Select All commands.

## Current status

The browser interface and native website WebViews are implemented for macOS using Tauri's unstable child-WebView API. Production filtering uses WKContentRuleList and the constrained adblock-rust compiler. Windows and Linux interception validation is deferred to a later cross-platform milestone; macOS is the active development platform for now. See [the roadmap](docs/roadmap.md), [filtering details](docs/filtering.md), and [platform matrix](docs/platform-matrix.md). This prototype is not a general-purpose secure browser yet.

### Build metadata

Tauri builds generate `src/build-metadata.json` for the frontend and `src-tauri/build-metadata.env` for the Rust build. The generated Rust environment values are embedded in the binary and shown in the Settings About section and the macOS **Unky → About Unky** menu dialog. The metadata contains the package version, build number, UTC build timestamp, and short commit.

Local builds use the `BUILD_NUMBER` environment variable when set, otherwise `local`. GitHub Actions uses `GITHUB_RUN_NUMBER`. The macOS release workflow generates metadata before packaging and names the DMG with version, build number, timestamp, commit, and architecture. Run `npm run build:metadata` to regenerate metadata manually.

### Local macOS DMG builds

For a local macOS DMG, run `npm ci --legacy-peer-deps` and then `npm run tauri-release`; the bundle is created under `target/release/bundle/dmg/`. Set `BUILD_NUMBER` to label a local build, for example `BUILD_NUMBER=42 npm run tauri-release`. The unsigned local command uses Tauri's default DMG filename. For a signed/notarized macOS build, use `npm run sign-mac`, which prompts for the Apple account email and app-specific password, requires the configured Developer ID certificate in the macOS keychain, and names the resulting DMG with the version, build number, UTC timestamp, commit, and architecture.

### Release process

Every public version goes through a version-bump pull request, a candidate build, and an approved publish run. Do not change `main` directly. A dry run is optional and requires a separate publish-workflow run from the real publication.

1. **Prepare the version PR.** Run `npm run release:patch` to increment the current patch version. The script drafts notes from commit subjects since the current version's Git tag, writes them to a temporary Markdown file, opens that file in `$VISUAL` or `$EDITOR` (falling back to `vi` or Notepad), and waits for the editor to close before using the saved notes. Use `npm run release:patch -- --from-git` to use commit subjects directly without opening an editor. Add `--dry-run` to preview the version and all file updates without writing them, or use `--notes "Fix a visible issue"` to supply a single note without the interactive editor. The script updates `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, the `my-browser` entry in `Cargo.lock`, and prepends the notes under the matching `## <version>` heading in `CHANGELOG.md`. Open a version-bump PR with those changes. Keep the package, Tauri, and Cargo versions identical; release preparation rejects mismatches or an empty notes section.
2. **Build a release candidate.** Merge the PR to `main`. In GitHub Actions, run **Build desktop bundles** from `main` and set `release_version` to that version. The workflow creates a signed and notarized macOS ARM64 DMG, captures the real macOS app window with a curated showcase page, and builds Windows x64 and ARM64 NSIS installers. Windows installers are currently unsigned. The final job uploads a `release-candidate-<version>` artifact containing the installers, versioned app screenshot, `release.json`, `RELEASE_NOTES.md`, `SHA256SUMS.txt`, and the generated download-page preview. Candidate artifacts are retained for 14 days.
3. **Review the candidate.** Open the completed build run and download its `release-candidate-<version>` artifact. Review `Unky_<version>_screenshot.png` alongside the installers, release notes, checksums, and generated page before publishing. The publish workflow deploys the versioned screenshot with the page, which displays it beneath the download button.
2. **Build a release candidate.** Merge the PR to `main`. In GitHub Actions, run **Build desktop bundles** from `main` and set `release_version` to that version. The workflow creates a signed and notarized macOS ARM64 DMG and builds Windows x64 and ARM64 NSIS installers. Windows installers are currently unsigned. The final job uploads a `release-candidate-<version>` artifact containing the installers, `release.json`, `RELEASE_NOTES.md`, `SHA256SUMS.txt`, and the generated download-page preview. The preview marks this release date as pending until publication. Candidate artifacts are retained for 14 days.
3. **Review the candidate.** Open the completed build run and download its `release-candidate-<version>` artifact. Review the installers, release notes, checksums, and generated page before publishing.
4. **Run a publish dry run.** From `main`, start **Publish approved release** with the same `version` and leave `publish` set to `false`. The workflow automatically selects the newest successful, unexpired candidate artifact for that version from the default branch; no Actions run ID is needed. The production approval links to the selected source run. After approval, the workflow validates the candidate and checks SSH access, then stops without creating a GitHub release or changing the public site.
5. **Publish for real.** After the dry run succeeds and the candidate is approved, start a new **Publish approved release** run for the same version with `publish` set to `true`. After production approval, it creates the `v<version>` GitHub Release with the installers, screenshot, checksums, and generated release notes, then deploys the immutable installers, screenshot, checksums, and updated download page.

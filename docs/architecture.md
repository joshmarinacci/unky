# Architecture

## Current proof of concept

- `src/` is the trusted React/TypeScript browser chrome.
- `src-tauri/` owns native window and WebView creation, URL validation, and navigation.
- The `main` UI and `page` website content are separate WebViews. `page` receives no capability file; the only configured capability is scoped to the `main` WebView label.
- Rust owns the tab state and a separate native website WebView for each open tab. Only tab metadata is serialized; WebView handles stay in Tauri's registry.
- The trusted UI can create, select, and close tabs, navigate/search, reload/stop, and move backward or forward through observed page navigations. Website views are moved outside the window when inactive and resized to the content area reported by the trusted UI.
- Page load and title callbacks send tab snapshots to the trusted UI. The start page and toolbar are React; website pixels are rendered by native child WebViews.
- The sidebar can switch between tabs and bookmarks, and its width is resizable and persisted in the UI's `localStorage`. Bookmarks are managed in the sidebar and stored locally in that same UI store.
- The React browser chrome uses React Aria Components for accessible controls, including sidebar tabs, tab and bookmark trees, buttons, text fields, and the appearance selector. Lucide React supplies UI icons. React Aria provides interaction behavior and state attributes, while visual styles remain local in `src/style.css`.
- Settings can be opened from the app menu (`⌘,`) or toolbar. The interface appearance follows System, Light, or Dark preference. Opening Settings moves website child views out of the visible content area; closing Settings restores the active page view.
- On macOS, native menu items provide tab, navigation, editing, and zoom shortcuts. `⌘W` closes the active tab, `⌘H` hides the app, and `⌥⌘H` hides other apps. Website zoom is tracked per tab and adjusted from the View menu between 50% and 300%.
- `crates/blocker-core` is independent of Tauri and converts a documented ABP-style subset into Apple content-blocking JSON.
- The `navigate` command is only callable from the trusted `main` WebView, resolves address-bar searches through Google, adds HTTPS to bare hostnames (HTTP for localhost), and rejects non-HTTP(S) targets or embedded credentials.
- `tests/fixtures/server.py` serves a local page and logs requests.

## Filtering

`crates/blocker-core` uses adblock-rust to convert a deliberately constrained set of ABP-style network rules into Apple's content-blocking JSON. The macOS adapter compiles and installs that list on the website view. See [filtering scope](filtering.md) for supported rules and limitations.

## API verification

The pinned Tauri crate is set to 2.12.5. Tauri's `WebviewBuilder` and `Window::add_child` are gated by its `unstable` Cargo feature. Tauri's docs show child webview creation and make clear that `unstable` is required; the webview's size and position are initialized explicitly. WRY's current documentation says `build_as_child` works on macOS, Windows, and Linux X11, while GTK hosting is needed for Wayland. Tauri's `Webview::with_webview` exposes native handles on the main thread; the macOS implementation uses it to reach `WKUserContentController`.

References: [Tauri `WebviewBuilder`](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html), [Tauri `Window::add_child` source](https://docs.rs/tauri/latest/src/tauri/window/mod.rs.html), [WRY child WebViews](https://github.com/tauri-apps/wry#child-webviews).

## Intended boundaries

Filtering remains independent of Tauri in `crates/blocker-core`. The normal browser UI currently reports filtering as unavailable; the macOS content-rule integration remains a fixture test path. A later interception adapter must report capabilities and metadata gaps instead of implying that every platform exposes equivalent request context. Tabs, windows, and workspaces remain engine-independent state; native WebView handles stay in an adapter registry.

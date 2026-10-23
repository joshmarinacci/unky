# Architecture

## Current proof of concept

- `src/` is the trusted React/TypeScript browser chrome.
- `src-tauri/` owns native window and WebView creation, URL validation, and navigation.
- The `main` UI and `page` website content are separate WebViews. `page` receives no capability file; the only configured capability is scoped to the `main` WebView label.
- Rust owns a small independent serializable `TabState` model. Native WebView handles are not serialized.
- `crates/blocker-core` is independent of Tauri and converts a documented ABP-style subset into Apple content-blocking JSON.
- `navigate` accepts only absolute HTTP(S) URLs with a host and no embedded credentials, and only calls through for the trusted `main` WebView label.
- `tests/fixtures/server.py` serves a local page and logs requests.

## Filtering

`crates/blocker-core` uses adblock-rust to convert a deliberately constrained set of ABP-style network rules into Apple's content-blocking JSON. The macOS adapter compiles and installs that list on the website view. See [filtering scope](filtering.md) for supported rules and limitations.

## API verification

The pinned Tauri crate is set to 2.12.5. Tauri's `WebviewBuilder` and `Window::add_child` are gated by its `unstable` Cargo feature. Tauri's docs show child webview creation and make clear that `unstable` is required; the webview's size and position are initialized explicitly. WRY's current documentation says `build_as_child` works on macOS, Windows, and Linux X11, while GTK hosting is needed for Wayland. Tauri's `Webview::with_webview` exposes native handles on the main thread; the macOS implementation uses it to reach `WKUserContentController`.

References: [Tauri `WebviewBuilder`](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html), [Tauri `Window::add_child` source](https://docs.rs/tauri/latest/src/tauri/window/mod.rs.html), [WRY child WebViews](https://github.com/tauri-apps/wry#child-webviews).

## Intended boundaries

Filtering remains independent of Tauri in `crates/blocker-core`. A later interception adapter must report capabilities and metadata gaps instead of implying that every platform exposes equivalent request context. Tabs, windows, and workspaces remain engine-independent state; native WebView handles stay in an adapter registry.

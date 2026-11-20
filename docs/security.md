# Security

## Current controls

- Remote website content is loaded in a distinct child WebView, not in the trusted React UI view.
- Capabilities scope trusted browser UI commands to `main` and `browser-window-*`, page commands to website child WebViews, and the address-suggestions popup to events and `select_address_suggestion`.
- The popup selection command checks its caller label and owning browser window, then validates the HTTP(S) URL before navigating the active tab.
- `navigate` checks the caller WebView label in Rust and rejects non-HTTP(S) schemes, missing hosts, and embedded URL credentials.
- Page commands are callable by any script on a website, not only by Unky's injected helpers, so Rust gates them (`authorize_page_action` in `src-tauri/src/page_access.rs`). A page may open tabs, windows, the other split, or an external browser only when its tab is on screen, its window has focus, and the platform saw real input within the last second. Each gesture authorizes one open, and each tab is rate-limited. Tab-folder and installed-browser lookups need a recent gesture but do not spend it. Native input comes from an AppKit local event monitor on macOS and the system last-input tick on Windows (`src-tauri/src/browser/activation.rs`); other platforms apply only the rate limits.
- `focus_browser_tab` accepts only a tab that is already on screen in the focused window, so an offscreen background tab cannot bring itself to the front.
- A page that asks to open a URL other than its own in an external browser gets a native confirmation naming the URL and browser.
- Per-tab back/forward history is capped at 100 entries.
- View Source (`get_page_source`) is a trusted-UI command only. It downloads only the HTTP(S) URL the tab has already loaded, sends no cookies, follows at most 5 redirects, times out after 10 seconds, and caps the response at 5 MB. When the download fails it reads the page's DOM instead. The UI shows the result as text, never as markup.
- The trusted UI listens to Rust events only when they are sent to its own window (`onEvent` in `src/ipc.ts`), so one browser window never acts on another window's menu commands or tab snapshots.
- No filesystem, shell, or process plugins are included.
- The UI has a restrictive Content Security Policy.

Tauri documents that capabilities are merged when multiple matching scopes apply and recommends using explicit `webviews` scopes for multi-WebView windows. See [Tauri capabilities](https://tauri.app/security/capabilities/).

## Open work before this is a browser

The prototype does not yet implement redirect/new-window handling, permission prompts, downloads, safe external protocol handling, durable profile isolation, or a security regression suite. WebView creation currently uses Tauri's unstable child API and has not been built or exercised on the supported operating systems. Treat page metadata, icons, and future filter lists as untrusted input. Do not store credentials in SQLite.

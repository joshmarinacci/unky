# Security

## Current controls

- Remote website content is loaded in a distinct child WebView, not in the trusted React UI view.
- The capability manifest scopes Tauri's core permission set to the `main` WebView label. The website view has no capability entry.
- `navigate` checks the caller WebView label in Rust and rejects non-HTTP(S) schemes, missing hosts, and embedded URL credentials.
- No filesystem, shell, or process plugins are included.
- The UI has a restrictive Content Security Policy.

Tauri documents that capabilities are merged when multiple matching scopes apply and recommends using explicit `webviews` scopes for multi-WebView windows. See [Tauri capabilities](https://tauri.app/security/capabilities/).

## Open work before this is a browser

The prototype does not yet implement redirect/new-window handling, permission prompts, downloads, safe external protocol handling, durable profile isolation, or a security regression suite. WebView creation currently uses Tauri's unstable child API and has not been built or exercised on the supported operating systems. Treat page metadata, icons, and future filter lists as untrusted input. Do not store credentials in SQLite.

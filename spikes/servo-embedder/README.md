# Servo embedder spike

This standalone macOS app uses Servo's public Rust embedding API to render web
content in a native window. It is intentionally separate from Unky's Tauri
workspace so the engine dependency and native rendering stack do not affect the
shipping app yet. The default page is a local fixture lab under `pages/` with
responsive layout, forms, SVG/canvas, and JavaScript interaction cases.

Run from the repository root:

```sh
cargo run --manifest-path spikes/servo-embedder/Cargo.toml
```

Pass a URL (or a `file://` URL) to load a different page:

```sh
cargo run --manifest-path spikes/servo-embedder/Cargo.toml -- https://example.com
```

The first build compiles Servo and its JavaScript engine and can take a while.
The spike forwards pointer movement, clicks, scrolling, key presses and releases,
modifier state, and IME composition. It also clears held keys and composition
when the window loses focus. Integration with Unky's tab bar, persistence,
privacy modes, downloads, and native permissions remains outside this spike.

## Attach Servo to Unky's macOS page area

The `servo-in-tauri-spike` debug-only Cargo feature attaches a Servo OpenGL view
inside each native website WebView. One Servo engine is shared by all tabs; each
tab has its own Servo WebView and native rendering context. The existing Tauri
WebView remains as the geometry and lifecycle host. This experiment checks
rendering and resizing; native input routing, navigation synchronization, and
browser feature parity are still pending.

In one terminal, serve the local test pages:

```sh
python3 -m http.server 4179 --directory spikes/servo-embedder/pages
```

In another terminal, build the isolated Servo-enabled Unky app:

```sh
npm run tauri -- build --debug --bundles app --features servo-in-tauri-spike --config src-tauri/tauri.servo-spike.conf.json
```

Launch `target/debug/bundle/macos/Unky.app`, then open
`http://127.0.0.1:4179/index.html` in a new tab. A green **SERVO FRAME** badge
appears in Servo's copy of the lab page; the underlying WKWebView receives the
same page without the badge. This makes the visible renderer identifiable.
The separate app identifier keeps the spike session isolated from the regular
Unky profile. The feature is rejected in release builds.

The spike bundle has a dedicated `allow-jit` macOS entitlement. Without it,
SpiderMonkey's executable-memory reservation fails under Tauri's hardened
runtime and Servo initialization panics. The regular Unky configuration has no
Servo entitlement or dependency unless this feature is selected. The app catches
an attachment panic so that a failed Servo initialization does not abort Unky.

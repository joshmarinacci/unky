# My Browser

A Tauri 2, Rust, React, and TypeScript desktop browser prototype. The current implementation is Milestone 0: one trusted UI WebView, one separate website WebView, and a narrowly validated navigation command.

## Prerequisites

- Node.js 20.19+ or 22.12+, pnpm 9+
- Rust stable and the platform's Tauri prerequisites
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools and WebView2 Runtime
- Linux: GTK 3, WebKit2GTK 4.1, and the Tauri build dependencies for the target distribution

See the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for distribution-specific packages.

## Run

```sh
pnpm install
python3 tests/fixtures/server.py
pnpm tauri dev
```

The sample website is served on `127.0.0.1:4179`. It is intentionally a tiny local fixture, not an ad-blocking test yet.

## macOS interception smoke test

After installing dependencies, run `python3 tests/macos_interception_test.py` on macOS. The test enables the `macos-interception-test` Cargo feature, compiles a WKContentRuleList that blocks only `http://127.0.0.1:4180/blocked.png`, and loads the fixture from `http://127.0.0.1:4179/`. It passes only when the server records `/allowed.png` and does not record `/blocked.png`.

## Current status

Milestone 0 is scaffolded. The separate website WebView uses Tauri's unstable child-WebView API. The macOS interception smoke test passes. Windows and Linux interception validation is deferred to a later milestone; macOS is the active development platform for now. See [the roadmap](docs/roadmap.md) and [platform matrix](docs/platform-matrix.md). This prototype is not a general-purpose secure browser yet.
